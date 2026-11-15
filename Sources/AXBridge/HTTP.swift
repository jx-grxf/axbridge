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
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[separator.upperBound...]
        guard body.count >= length else { return nil }
        method = String(requestLine[0])
        path = String(requestLine[1])
        self.headers = headers
        self.body = String(decoding: body.prefix(length), as: UTF8.self)
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
