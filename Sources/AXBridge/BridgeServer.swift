#if canImport(UIKit) && DEBUG && targetEnvironment(simulator)
import Foundation
import Network
import UIKit

@MainActor
final class BridgeServer {
    static let shared = BridgeServer()

    private var listener: NWListener?
    private var openURL: ((URL) -> Void)?
    private var token = ""
    private let queue = DispatchQueue(label: "dev.axbridge.server")
    let reader = ScreenReader()

    func start(openURL: ((URL) -> Void)?) {
        guard listener == nil else { return }
        self.openURL = openURL
        let env = ProcessInfo.processInfo.environment
        guard let token = env["AXBRIDGE_TOKEN"], !token.isEmpty else {
            print("AXBridge: AXBRIDGE_TOKEN missing, not starting")
            return
        }
        self.token = token
        let rawPort = env["AXBRIDGE_PORT"].flatMap(UInt16.init) ?? 47_100
        guard let port = NWEndpoint.Port(rawValue: rawPort) else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        parameters.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: parameters) else {
            print("AXBridge: port \(rawPort) unavailable")
            return
        }
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            BridgeServer.receive(on: connection, buffer: Data())
        }
        listener.start(queue: queue)
        self.listener = listener
        print("AXBridge: listening on 127.0.0.1:\(rawPort)")
    }

    nonisolated private static func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = BridgeRequest(buffer) {
                Task { @MainActor in
                    let (status, body) = await BridgeServer.shared.respond(to: request)
                    connection.send(content: BridgeResponse.encode(status: status, body: body),
                                    completion: .contentProcessed { _ in connection.cancel() })
                }
            } else if isComplete || error != nil || buffer.count > 1_000_000 {
                connection.cancel()
            } else {
                receive(on: connection, buffer: buffer)
            }
        }
    }

    private func respond(to request: BridgeRequest) async -> (String, String) {
        guard BridgeAuth.check(request, token: token) else { return ("401 Unauthorized", "token required") }
        let argument = request.body.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (request.method, request.path) {
        case ("GET", "/screen"):
            return ("200 OK", reader.render(reader.collect()))
        case ("POST", "/tap"):
            return await tap(argument)
        case ("POST", "/type"):
            guard let input = await reader.focusedOrOnlyInput() else { return noInput() }
            input.insertText(request.body)
            return ("200 OK", await settled())
        case ("POST", "/clear"):
            guard let input = await reader.focusedOrOnlyInput() else { return noInput() }
            var count = 0
            while input.hasText, count < 1000 {
                input.deleteBackward()
                count += 1
            }
            return ("200 OK", await settled())
        case ("POST", "/go"):
            guard let url = URL(string: argument), url.scheme != nil else {
                return ("400 Bad Request", "not a URL: \(argument)")
            }
            if let openURL {
                openURL(url)
            } else {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return ("200 OK", await settled())
        case ("POST", "/scroll"):
            guard reader.scroll(argument.isEmpty ? "down" : argument) else {
                return ("409 Conflict", "nothing to scroll")
            }
            return ("200 OK", await settled())
        case ("POST", "/back"):
            guard reader.goBack() else { return ("409 Conflict", "no screen to go back from") }
            return ("200 OK", await settled())
        case ("POST", "/frame"):
            guard let element = reader.find(argument) else { return ("404 Not Found", "not found: \(argument)") }
            let f = element.frame
            return ("200 OK", "\(Int(f.minX)) \(Int(f.minY)) \(Int(f.width)) \(Int(f.height)) \(reader.screenScale)")
        default:
            return ("404 Not Found", "GET /screen · POST /tap /type /clear /go /scroll /back /frame")
        }
    }

    private func noInput() -> (String, String) {
        ("409 Conflict", "no focused text field; tap the field first (\(reader.lastFocusAttempt))")
    }

    private func tap(_ target: String) async -> (String, String) {
        reader.collect()
        guard let element = reader.find(target) else {
            return ("404 Not Found", "not found: \(target)\n\n" + reader.render(reader.lastElements))
        }
        if reader.activate(element) { return ("200 OK", await settled()) }
        let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
        return ("202 Accepted", "cannot activate, tap at \(Int(center.x)) \(Int(center.y))")
    }

    private func settled() async -> String {
        try? await Task.sleep(nanoseconds: 700_000_000)
        return reader.render(reader.collect())
    }
}
#endif
