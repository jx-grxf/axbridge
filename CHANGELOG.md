# Changelog

## 0.2.0

**Swift package**
- Release builds contain no code from the package: `AXBridge` and the HTTP helpers exist only in Debug builds. Wrap `import AXBridge` and `AXBridge.start` in `#if DEBUG`.
- Alerts, confirmation dialogs, popovers and overlay windows are now detected and listed on top of the main window.
- Custom accessibility actions (`.swipeActions` etc.) appear as `actions:[…]` in `/screen` and can be invoked via `POST /action`.
- Adjustable controls (`Slider`, `Stepper`, `Picker`) can be driven via `POST /adjust` (`increment` / `decrement`).
- In-process `POST /wait` waits for elements/text to appear or disappear; `POST /scroll` accepts JSON with `target` to scroll until visible; `POST /type` supports `X-AXBridge-Submit: 1`; `POST /clear` reliably clears `UITextField` and `UITextView` regardless of cursor position.
- Adaptive settling replaces the fixed 700 ms post-action delay.

**MCP server, CLI, TUI & local analytics**
- **Xcode 27 / macOS 27 Device Hub support:** `boot --show`, `doctor`, and the TUI automatically detect and open `DeviceHub.app` (falling back to `Simulator.app` on Xcode 26 and earlier).
- **New MCP tools:** `action`, `adjust`, `wait_for`, `logs` (recent simulator app/process logs), `analytics`, plus `submit` on `type` and `target` on `scroll`.
- **Local analytics & insights:** privacy-first JSONL telemetry at `~/.cache/axbridge/analytics.jsonl` (`AXBRIDGE_NO_ANALYTICS=1` to disable, never logs typed text or secrets) with p50/p95 latency, error rates, token savings, and automated improvement suggestions.
- **Interactive TUI & upgraded CLI:** `npx axbridge-mcp tui` launches a 4-tab terminal UI (Live Screen Inspector, Devices & Device Hub, Analytics Dashboard, Doctor); CLI adds styled output and `devices`, `boot`, `tap`, `type`, `scroll`, `action`, `adjust`, `back`, `go`, `wait`, `logs`, `analytics`.
- **Review fixes:**
  - Swift: a negative `Content-Length` no longer crashes the app; `/scroll` rejects unknown directions with `400`; `/adjust` refuses elements that are not adjustable and now really drives SwiftUI `Stepper` (it reported success without changing anything), and tapping a stepper button works; `/clear` selects all and deletes, so delegates and SwiftUI bindings see a normal edit; labels with line breaks stay on one line; custom actions are called through their IMP only for the signatures UIKit documents; `/frame` reads the current screen.
  - CLI: `doctor` and `analytics` wrap and cap their boxes to the terminal width (many saved sessions no longer stretch the frame, the top border is as wide as the body, wide characters are measured by terminal cells); the screen parser reads the unquoted listing the app prints; numeric flags are validated, `--` ends flags, unknown commands exit 1 with help on stderr, a non-activatable element exits 2, and output is flushed before exit.
  - TUI: flicker-free redraw, whole-chunk key handling (fast arrow repeats, paste), analytics and doctor tabs fit the terminal, terminal is restored after a crash or hang-up.
  - Analytics: deep links are reduced to scheme and host, error messages to their first line (bridge errors carried field contents), the home directory is masked, the file stays bounded and damaged lines are skipped.
  - MCP: starts from the cached update check instead of waiting for npm; `logs` matches the app's real executable name, requests `info` messages, reports an empty result and explains a shut-down simulator; the selected Xcode's viewer wins over another install; `record_stop` no longer hangs when the recording already ended.
- **Bug fixes:** clamped element screenshot crops to PNG bounds to prevent `sips` edge errors, ensured `OUTPUT_DIR` exists for `record_start`, cleaned up temp files in `push`, and wrapped `ExampleApp.swift` in `#if DEBUG`.

## 0.1.1

**CLI**
- `npx axbridge-mcp setup claude|codex|cursor|all` registers the MCP server with your agent.
- `npx axbridge-mcp doctor` checks Xcode, simulators, Node and whether a newer version exists.
- `npx axbridge-mcp screen [device]` prints the current screen of an app launched by axbridge.
- The package also installs the command as `axbridge`.

**Updates**
- The server checks npm at most once a day (1.5 s timeout, off with `AXBRIDGE_NO_UPDATE_CHECK=1`). When a newer version exists, the agent is told on its first call.
- New tool `update`: fetches the new version for npx and lists every place in your repository that pins an axbridge version.

**Install**

```bash
claude mcp add axbridge -- npx -y axbridge-mcp
```

The Swift package is unchanged from 0.1.0.

## 0.1.0

First release.

**Swift package `AXBridge`** (iOS 15+, Debug builds in the Simulator only)
- Reports the visible screen from the in-process accessibility tree as text; a presented sheet hides the screen below it.
- Activates buttons, rows, tab bar items and text fields by label, `#n` or `id:identifier`.
- Inserts text without the software keyboard, clears fields, scrolls, goes back (sheet or navigation stack) and opens deep links through your own handler.
- Loopback only, a random token per launch, browser requests rejected.

**MCP server `axbridge-mcp`** (Node 20+, macOS with Xcode)
- Text: `screen`, `tap`, `type`, `scroll`, `back`, `go`; every action returns the new screen.
- Devices: `devices`, `boot`, `shutdown`, `create_device`; several simulators side by side.
- Apps: `build_and_run`, `install`, `launch` (arguments, environment, UserDefaults, fresh start), `terminate`, `uninstall`.
- State: `set_location`, `set_appearance`, `set_text_size`, `status_bar`, `permission`, `push`.
- Images: `screenshot` (500 px, optional crop to one element), `screenshots` across devices, `record_start` / `record_stop`, `compare` against a reference PNG.
