#if DEBUG
import Foundation

/// A minimal HTTP/1.1 request, enough for the loopback protocol between the app and the
/// MCP server. Platform independent so it can be tested on macOS.
public struct BridgeRequest: Equatable {
    public let method: String
    public let path: String
    public let headers: [String: String]
    public let body: String

    /// Returns nil while the request is incomplete (headers or body still arriving).
    public init?(_ data: Data) {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[..<separator.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.first?.split(separator: " ") ?? []
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = max(0, Int(headers["content-length"] ?? "0") ?? 0)
        let body = data[separator.upperBound...]
        guard body.count >= length else { return nil }
        method = String(requestLine[0])
        path = String(requestLine[1])
        self.headers = headers
        self.body = String(decoding: body.prefix(length), as: UTF8.self)
    }

    public var shouldSubmit: Bool {
        guard let raw = headers["x-axbridge-submit"]?.trimmingCharacters(in: .whitespaces).lowercased() else {
            return false
        }
        return raw == "1" || raw == "true"
    }
}

public struct ActionRequest: Equatable {
    public let target: String
    public let action: String

    private struct Payload: Decodable {
        let target: String
        let action: String
    }

    public static func parse(_ body: String) -> ActionRequest? {
        guard let data = body.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return nil }
        let target = payload.target.trimmingCharacters(in: .whitespacesAndNewlines)
        let action = payload.action.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, !action.isEmpty else { return nil }
        return ActionRequest(target: target, action: action)
    }
}

public enum AdjustDirection: String, Equatable {
    case increment
    case decrement
}

public struct AdjustRequest: Equatable {
    public let target: String
    public let direction: AdjustDirection
    public let steps: Int

    private struct Payload: Decodable {
        let target: String
        let direction: String
        let steps: Int?
    }

    public static func parse(_ body: String) -> AdjustRequest? {
        guard let data = body.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              let direction = AdjustDirection(rawValue: payload.direction.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) else {
            return nil
        }
        let target = payload.target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return nil }
        let steps = max(1, min(payload.steps ?? 1, 20))
        return AdjustRequest(target: target, direction: direction, steps: steps)
    }
}

public enum WaitState: String, Equatable {
    case appear
    case disappear
}

public struct WaitRequest: Equatable {
    public let target: String
    public let state: WaitState
    public let timeoutMs: Int

    private struct Payload: Decodable {
        let target: String
        let state: String?
        let timeoutMs: Int?
    }

    public static func parse(_ body: String) -> WaitRequest? {
        guard let data = body.data(using: .utf8),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            return nil
        }
        let target = payload.target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { return nil }
        let rawState = payload.state?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "appear"
        guard let state = WaitState(rawValue: rawState) else { return nil }
        let timeoutMs = max(100, min(payload.timeoutMs ?? 10_000, 60_000))
        return WaitRequest(target: target, state: state, timeoutMs: timeoutMs)
    }
}

public struct ScrollRequest: Equatable {
    public static let validDirections: Set<String> = ["down", "up", "top", "bottom", "left", "right"]

    public let direction: String
    public let target: String?
    public let maxSwipes: Int

    private struct Payload: Decodable {
        let direction: String?
        let target: String?
        let maxSwipes: Int?
    }

    public static func parse(_ body: String) -> ScrollRequest? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") {
            guard let data = trimmed.data(using: .utf8),
                  let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
                return nil
            }
            let dir = payload.direction?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let direction = (dir?.isEmpty == false ? dir : nil) ?? "down"
            guard validDirections.contains(direction) else { return nil }
            let target: String?
            if let rawTarget = payload.target {
                let clean = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !clean.isEmpty else { return nil }
                target = clean
            } else {
                target = nil
            }
            let maxSwipes = max(1, min(payload.maxSwipes ?? 8, 25))
            return ScrollRequest(direction: direction, target: target, maxSwipes: maxSwipes)
        }
        let direction = trimmed.isEmpty ? "down" : trimmed.lowercased()
        guard validDirections.contains(direction) else { return nil }
        return ScrollRequest(direction: direction, target: nil, maxSwipes: 8)
    }
}

enum ScreenText {
    /// One accessibility element per line: labels and values may contain line breaks, which would
    /// otherwise split an element across lines and break parsers of the listing.
    static func oneLine(_ text: String) -> String {
        guard text.contains(where: \.isNewline) else { return text }
        return text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

public enum BridgeAuth {
    /// Browsers attach `Origin` to cross-site requests; the MCP server never does. Rejecting
    /// it keeps a web page on the same Mac from driving the app over loopback.
    public static func check(_ request: BridgeRequest, token: String) -> Bool {
        if request.headers["origin"] != nil { return false }
        guard let sent = request.headers["x-axbridge-token"], !token.isEmpty else { return false }
        return constantTimeEqual(Array(sent.utf8), Array(token.utf8))
    }

    static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in a.indices { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}

public enum BridgeResponse {
    public static func encode(status: String, body: String) -> Data {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/plain; charset=utf-8\r\n"
            + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
        return Data((head + body).utf8)
    }
}
#endif
