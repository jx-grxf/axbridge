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
            if request.shouldSubmit { reader.submitInput(input) }
            return ("200 OK", await settled())
        case ("POST", "/clear"):
            guard let input = await reader.focusedOrOnlyInput() else { return noInput() }
            reader.clearInput(input)
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
            return await scroll(request.body)
        case ("POST", "/back"):
            guard reader.goBack() else { return ("409 Conflict", "no screen to go back from") }
            return ("200 OK", await settled())
        case ("POST", "/frame"):
            reader.collect()
            guard let element = reader.find(argument) else { return ("404 Not Found", "not found: \(argument)") }
            let f = element.frame
            return ("200 OK", "\(Int(f.minX)) \(Int(f.minY)) \(Int(f.width)) \(Int(f.height)) \(reader.screenScale)")
        case ("POST", "/action"):
            return await performAction(request.body)
        case ("POST", "/adjust"):
            return await adjust(request.body)
        case ("POST", "/wait"):
            return await waitFor(request.body)
        default:
            return ("404 Not Found", "GET /screen · POST /tap /type /clear /go /scroll /back /frame /action /adjust /wait")
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

    private func performAction(_ body: String) async -> (String, String) {
        guard let req = ActionRequest.parse(body) else {
            return ("400 Bad Request", "expected JSON {\"target\": \"...\", \"action\": \"...\"}")
        }
        switch reader.performAction(target: req.target, actionName: req.action) {
        case .ok:
            return ("200 OK", await settled())
        case .notFound:
            return ("404 Not Found", "not found: \(req.target)\n\n" + reader.render(reader.lastElements))
        case .noMatchingAction(let available):
            let list = available.isEmpty ? "none" : available.joined(separator: ", ")
            return ("409 Conflict", "no matching action '\(req.action)' (available: \(list))")
        }
    }

    private func adjust(_ body: String) async -> (String, String) {
        guard let req = AdjustRequest.parse(body) else {
            return ("400 Bad Request", "expected JSON {\"target\": \"...\", \"direction\": \"increment\"|\"decrement\", \"steps\": 1}")
        }
        reader.collect()
        guard let element = reader.find(req.target) else {
            return ("404 Not Found", "not found: \(req.target)\n\n" + reader.render(reader.lastElements))
        }
        guard reader.adjust(element, direction: req.direction.rawValue, steps: req.steps) else {
            return ("409 Conflict", "\(req.target) is not an adjustable control (Slider, Stepper, Picker)")
        }
        return ("200 OK", await settled())
    }

    private func waitFor(_ body: String) async -> (String, String) {
        guard let req = WaitRequest.parse(body) else {
            return ("400 Bad Request", "expected JSON {\"target\": \"...\", \"state\": \"appear\"|\"disappear\", \"timeoutMs\": 10000}")
        }
        let deadline = CFAbsoluteTimeGetCurrent() + Double(req.timeoutMs) / 1000.0
        while true {
            reader.collect()
            let found = reader.find(req.target) != nil
            if (req.state == .appear && found) || (req.state == .disappear && !found) {
                return ("200 OK", reader.render(reader.lastElements))
            }
            let remaining = deadline - CFAbsoluteTimeGetCurrent()
            if remaining <= 0 {
                return ("408 Request Timeout", "timed out waiting for \(req.target) to \(req.state.rawValue)\n\n" + reader.render(reader.lastElements))
            }
            let sleepNs = UInt64(min(0.15, remaining) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: max(1_000_000, sleepNs))
        }
    }

    private func scroll(_ body: String) async -> (String, String) {
        guard let req = ScrollRequest.parse(body) else {
            return ("400 Bad Request", "expected down|up|top|bottom|left|right or JSON {\"direction\": \"down\", \"target\": \"...\", \"maxSwipes\": 8}")
        }
        guard let target = req.target else {
            guard reader.scroll(req.direction) else {
                return ("409 Conflict", "nothing to scroll")
            }
            return ("200 OK", await settled())
        }
        reader.collect()
        if reader.find(target) != nil {
            return ("200 OK", reader.render(reader.lastElements))
        }
        for _ in 0..<req.maxSwipes {
            guard reader.scroll(req.direction) else { break }
            try? await Task.sleep(nanoseconds: 200_000_000)
            reader.collect()
            if reader.find(target) != nil {
                return ("200 OK", reader.render(reader.lastElements))
            }
        }
        let screen = reader.render(reader.collect())
        return ("409 Conflict", "not found after scrolling: \(target)\n\n" + screen)
    }

    private func settled() async -> String {
        let deadline = CFAbsoluteTimeGetCurrent() + 0.9
        try? await Task.sleep(nanoseconds: 180_000_000)
        var previous = reader.render(reader.collect())
        while CFAbsoluteTimeGetCurrent() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
            let current = reader.render(reader.collect())
            if current == previous { return current }
            previous = current
        }
        return previous
    }
}
#endif
