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

    func testShouldSubmitHeader() throws {
        let one = try XCTUnwrap(request("POST /type HTTP/1.1\r\nX-AXBridge-Submit: 1\r\nContent-Length: 2\r\n\r\nhi"))
        let truthy = try XCTUnwrap(request("POST /type HTTP/1.1\r\nx-axbridge-submit: TRUE\r\nContent-Length: 2\r\n\r\nhi"))
        let falsy = try XCTUnwrap(request("POST /type HTTP/1.1\r\nX-AXBridge-Submit: false\r\nContent-Length: 2\r\n\r\nhi"))
        let absent = try XCTUnwrap(request("POST /type HTTP/1.1\r\nContent-Length: 2\r\n\r\nhi"))
        XCTAssertTrue(one.shouldSubmit)
        XCTAssertTrue(truthy.shouldSubmit)
        XCTAssertFalse(falsy.shouldSubmit)
        XCTAssertFalse(absent.shouldSubmit)
    }

    func testActionRequestParsing() {
        let valid = ActionRequest.parse(#"{"target": "Station 1", "action": "Pin"}"#)
        XCTAssertEqual(valid, ActionRequest(target: "Station 1", action: "Pin"))
        XCTAssertNil(ActionRequest.parse(#"{"target": "", "action": "Pin"}"#))
        XCTAssertNil(ActionRequest.parse(#"{"target": "Station 1", "action": "  "}"#))
        XCTAssertNil(ActionRequest.parse(#"{"target": "Station 1"}"#))
        XCTAssertNil(ActionRequest.parse("not json"))
    }

    func testAdjustRequestParsing() {
        let defaultSteps = AdjustRequest.parse(#"{"target": "Refresh", "direction": "increment"}"#)
        XCTAssertEqual(defaultSteps, AdjustRequest(target: "Refresh", direction: .increment, steps: 1))

        let clampedHigh = AdjustRequest.parse(#"{"target": "Volume", "direction": "DECREMENT", "steps": 99}"#)
        XCTAssertEqual(clampedHigh, AdjustRequest(target: "Volume", direction: .decrement, steps: 20))

        let clampedLow = AdjustRequest.parse(#"{"target": "Volume", "direction": "increment", "steps": 0}"#)
        XCTAssertEqual(clampedLow, AdjustRequest(target: "Volume", direction: .increment, steps: 1))

        XCTAssertNil(AdjustRequest.parse(#"{"target": "Volume", "direction": "sideways"}"#))
        XCTAssertNil(AdjustRequest.parse(#"{"target": "  ", "direction": "increment"}"#))
        XCTAssertNil(AdjustRequest.parse("bad"))
    }

    func testWaitRequestParsing() {
        let defaults = WaitRequest.parse(#"{"target": "Done"}"#)
        XCTAssertEqual(defaults, WaitRequest(target: "Done", state: .appear, timeoutMs: 10_000))

        let custom = WaitRequest.parse(#"{"target": "Spinner", "state": "disappear", "timeoutMs": 5000}"#)
        XCTAssertEqual(custom, WaitRequest(target: "Spinner", state: .disappear, timeoutMs: 5000))

        let clampedMin = WaitRequest.parse(#"{"target": "Done", "timeoutMs": 10}"#)
        XCTAssertEqual(clampedMin?.timeoutMs, 100)

        let clampedMax = WaitRequest.parse(#"{"target": "Done", "timeoutMs": 999999}"#)
        XCTAssertEqual(clampedMax?.timeoutMs, 60_000)

        XCTAssertNil(WaitRequest.parse(#"{"target": "Done", "state": "invalid"}"#))
        XCTAssertNil(WaitRequest.parse(#"{"target": ""}"#))
        XCTAssertNil(WaitRequest.parse("{}"))
    }

    func testScrollRequestParsing() {
        XCTAssertEqual(ScrollRequest.parse(""), ScrollRequest(direction: "down", target: nil, maxSwipes: 8))
        XCTAssertEqual(ScrollRequest.parse("up"), ScrollRequest(direction: "up", target: nil, maxSwipes: 8))
        XCTAssertEqual(ScrollRequest.parse("  Bottom\n"), ScrollRequest(direction: "bottom", target: nil, maxSwipes: 8))
        XCTAssertNil(ScrollRequest.parse("bogus"))

        let jsonTarget = ScrollRequest.parse(#"{"target": "Graz Jakominiplatz"}"#)
        XCTAssertEqual(jsonTarget, ScrollRequest(direction: "down", target: "Graz Jakominiplatz", maxSwipes: 8))

        let jsonClamped = ScrollRequest.parse(#"{"direction": "TOP", "target": "Station 1", "maxSwipes": 50}"#)
        XCTAssertEqual(jsonClamped, ScrollRequest(direction: "top", target: "Station 1", maxSwipes: 25))

        let jsonMin = ScrollRequest.parse(#"{"direction": "left", "maxSwipes": 0}"#)
        XCTAssertEqual(jsonMin, ScrollRequest(direction: "left", target: nil, maxSwipes: 1))

        XCTAssertNil(ScrollRequest.parse(#"{"direction": "diagonal"}"#))
        XCTAssertNil(ScrollRequest.parse(#"{"target": ""}"#))
        XCTAssertNil(ScrollRequest.parse("{bad json"))
    }

    func testNegativeContentLengthDoesNotCrash() throws {
        let parsed = try XCTUnwrap(request("POST /tap HTTP/1.1\r\nContent-Length: -5\r\n\r\nLogin"))
        XCTAssertEqual(parsed.body, "")
        let garbage = try XCTUnwrap(request("POST /tap HTTP/1.1\r\nContent-Length: abc\r\n\r\nLogin"))
        XCTAssertEqual(garbage.body, "")
    }

    func testBodyIsCutAtContentLength() throws {
        let parsed = try XCTUnwrap(request("POST /tap HTTP/1.1\r\nContent-Length: 3\r\n\r\nLogin"))
        XCTAssertEqual(parsed.body, "Log")
    }

    func testListingTextStaysOnOneLine() {
        XCTAssertEqual(ScreenText.oneLine("Save"), "Save")
        XCTAssertEqual(ScreenText.oneLine("Wien\nPraterstern"), "Wien Praterstern")
        XCTAssertEqual(ScreenText.oneLine("  a \r\n\n b  "), "a b")
        XCTAssertEqual(ScreenText.oneLine("\n"), "")
    }
}
