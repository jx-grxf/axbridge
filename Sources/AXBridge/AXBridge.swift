/// Lets a coding agent drive the app in the iOS Simulator as text: read the screen from the
/// accessibility tree, activate elements by name, type, scroll, go back and open deep links.
///
/// Started only when the app is launched with `--axbridge` (the MCP server does that). The
/// server runs only in Debug builds in the Simulator. Release builds contain no code from
/// this package at all, so wrap the import and every call in `#if DEBUG`.
#if DEBUG
import Foundation

public enum AXBridge {
    /// True when the app was launched by the MCP server. Use it to skip onboarding,
    /// review prompts or anything else that would stand between an agent and the screen
    /// it should check.
    public static var isActive: Bool {
        ProcessInfo.processInfo.arguments.contains("--axbridge")
    }

    /// Starts the loopback server if the app was launched with `--axbridge`.
    ///
    /// - Parameter openURL: how the app handles a deep link. Without it, `go` falls back to
    ///   `UIApplication.open`, which makes iOS ask before switching to the app.
    @MainActor
    public static func start(openURL: ((URL) -> Void)? = nil) {
        #if canImport(UIKit) && DEBUG && targetEnvironment(simulator)
        guard isActive else { return }
        BridgeServer.shared.start(openURL: openURL)
        #endif
    }
}
#endif
