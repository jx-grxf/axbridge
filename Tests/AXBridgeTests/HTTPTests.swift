import XCTest
@testable import AXBridge

final class HTTPTests: XCTestCase {
    private func request(_ raw: String) -> BridgeRequest? {
        BridgeRequest(Data(raw.utf8))
    }

    func testParsesRequestWithBody() throws {
        let parsed = try XCTUnwrap(request("POST /tap HTTP/1.1\r\nContent-Length: 5\r\nX-AXBridge-Token: abc\r\n\r\nLogin"))
        XCTAssertEqual(parsed.method, "POST")
        XCTAssertEqual(parsed.path, "/tap")
        XCTAssertEqual(parsed.body, "Login")
        XCTAssertEqual(parsed.headers["x-axbridge-token"], "abc")
    }

    func testWaitsForIncompleteBody() {
        XCTAssertNil(request("POST /type HTTP/1.1\r\nContent-Length: 10\r\n\r\nGraz"))
        XCTAssertNil(request("GET /screen HTTP/1.1\r\n"))
    }

    func testBodyIsMeasuredInBytes() throws {
        let body = "Gösting"
        let parsed = try XCTUnwrap(request("POST /type HTTP/1.1\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"))
        XCTAssertEqual(parsed.body, body)
    }

    func testRejectsMissingOrWrongToken() throws {
        let none = try XCTUnwrap(request("GET /screen HTTP/1.1\r\n\r\n"))
        let wrong = try XCTUnwrap(request("GET /screen HTTP/1.1\r\nX-AXBridge-Token: nope\r\n\r\n"))
        XCTAssertFalse(BridgeAuth.check(none, token: "secret"))
        XCTAssertFalse(BridgeAuth.check(wrong, token: "secret"))
    }

    func testRejectsBrowserRequestsEvenWithToken() throws {
        let browser = try XCTUnwrap(request("GET /screen HTTP/1.1\r\nOrigin: https://example.com\r\nX-AXBridge-Token: secret\r\n\r\n"))
        XCTAssertFalse(BridgeAuth.check(browser, token: "secret"))
    }

    func testAcceptsMatchingToken() throws {
        let ok = try XCTUnwrap(request("GET /screen HTTP/1.1\r\nX-AXBridge-Token: secret\r\n\r\n"))
        XCTAssertTrue(BridgeAuth.check(ok, token: "secret"))
        XCTAssertFalse(BridgeAuth.check(ok, token: ""))
    }

    func testResponseCarriesByteLength() {
        let text = String(decoding: BridgeResponse.encode(status: "200 OK", body: "Ö"), as: UTF8.self)
        XCTAssertTrue(text.contains("Content-Length: 2\r\n"))
    }

    func testIsActiveIsFalseInTests() {
        XCTAssertFalse(AXBridge.isActive)
    }
}
