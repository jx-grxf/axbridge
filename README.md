<div align="center">

# axbridge

**Let coding agents use your iOS app in the Simulator as text: read the screen from the accessibility tree, tap by name, type, scroll and go back. Screenshots stay available when the look matters.**

[![CI](https://github.com/jx-grxf/axbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jx-grxf/axbridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/axbridge-mcp?label=axbridge-mcp)](https://www.npmjs.com/package/axbridge-mcp)
![Platform](https://img.shields.io/badge/platform-iOS%20Simulator-0ea5e9)
![Swift](https://img.shields.io/badge/Swift-5.9%2B-F05138?logo=swift&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-111827)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Install](#install) · [Tools](#tools) · [How it works](docs/ARCHITECTURE.md) · [Agent setup](docs/AGENTS.md) · [Security](SECURITY.md)

</div>

---

> [!TIP]
> Built for the moment an agent says “let me check that in the Simulator” and then spends
> twenty minutes taking screenshots and guessing tap coordinates.

An MCP server for Claude Code, Codex, Cursor and any other MCP client, plus a small Swift
package for the app under test. The app reports what is on screen as a few lines of text:

```
1 [header] Stations  @201,108
2 [search] Search stations  @201,160
3 [button] Graz Jakominiplatz  @201,226
4 [button] Wien Praterstern  @201,270
5 [button] Stations  @100,822
6 [button] Settings  @300,822
```

The agent answers with `tap "Wien Praterstern"` and gets the next screen back as text.

## What it does

**Reading and acting**
- `screen` lists every visible element with kind, label, value, accessibility identifier, custom actions (`actions:[…]`) and position. Alerts, confirmation dialogs, sheets and popovers hide the screen below them, as they do for the user.
- `tap` takes a label, part of one, `#3` from the last listing or `id:identifier`. It works on buttons, rows, tab bar items and SwiftUI text fields.
- `type` inserts text into the focused field without the software keyboard, so umlauts, emoji and long strings arrive intact. `clear: true` empties the field first; `submit: true` presses Return/Search.
- `action` triggers custom accessibility actions such as SwiftUI `.swipeActions` (`Delete`, `Pin`, …); `adjust` increments or decrements `Slider`, `Stepper` and `Picker` controls.
- `wait_for` waits in-process for an element or text to appear or disappear without polling loops.
- `scroll` (optionally with `target` to scroll until an element becomes visible), `back` (closes an alert/sheet or pops the navigation stack) and `go` (opens a deep link through your app's own handler, without the system's “Open in …?” prompt).
- Every action returns the new screen using adaptive settling, so an agent rarely needs a separate read.

**CLI, TUI & local analytics**
- `npx axbridge-mcp tui` opens an interactive full-screen terminal UI with live Screen Inspector & Controller, Devices/Device Hub control, Local Analytics dashboard and Doctor checks.
- Full CLI commands (exit code 2 when an element cannot be activated; `devices`, `boot`, `screen`, `tap`, `type`, `scroll`, `action`, `adjust`, `wait`, `back`, `go`, `logs`, `analytics`, `doctor`, `setup`) for scripting or debugging outside MCP.
- Local, privacy-first analytics (`~/.cache/axbridge/analytics.jsonl`, off with `AXBRIDGE_NO_ANALYTICS=1`, never logs typed text, deep-link queries or screen contents) tracks latency, error rates, token savings and flags pain points (retry loops, `202 cannot activate`, `not_found` hotspots, screenshot overuse, noisy trees) via `analytics` or `axbridge analytics`.

**Staying current**
- The server checks npm at most once a day. When a newer version exists, the agent is told
  on its first call and can run `update`, which fetches it and lists every place in your repo
  that pins a version.

**Seeing**
- `screenshot` returns a 500 px JPEG; `element` crops it to a single element. The full-resolution PNG is saved next to it for bug reports.
- `screenshots` captures several simulators at once, for example one layout on three screen widths.
- `record_start` / `record_stop` record an H.264 video; `compare` diffs the screen against a reference PNG and returns the share of changed pixels and a diff image.

**Devices, apps & logs**
- `devices`, `boot` (opens **Device Hub** on Xcode 27+ or **Simulator.app** on older Xcode with `show: true`), `shutdown`, `create_device`. Several simulators run side by side, each with its own port and token.
- `build_and_run` builds an Xcode scheme for the chosen simulator, installs it and launches it with the bridge. `install`, `launch`, `terminate`, `uninstall` and `logs` cover lifecycle and crash/console diagnostics.
- `launch` takes extra arguments, environment variables and UserDefaults, and `reset: "fresh"` starts as after a clean install. That is enough to skip onboarding or seed test state.
- `set_location`, `set_appearance`, `set_text_size` (Dynamic Type), `status_bar` (9:41), `permission` (grant camera, location … without the prompt) and `push`.

## Why text

A full-resolution iPhone screenshot costs an agent about 1,500 input tokens. The text form
of a typical screen is 100 to 300. Tapping by name also removes the guess-and-retry loop of
coordinate taps.

Measured on a production SwiftUI app, same task (plan a route, read the first connection,
check its row visually, open a second screen), same model:

| | Screenshots and coordinates | axbridge |
|---|---|---|
| Tool calls | 300 to 450 | 13 |
| Screenshots | 80 to 150 | 1 (cropped) |
| Context at the end | 250k to 350k tokens | about 51k |
| Wall time | 20 to 45 min | 30 s |

The first column is the range over earlier agent runs on that app, not a single run.

## Install

**Let your agent do it.** Paste this into Claude Code, Codex or Cursor inside your app's
repository:

```text
Set up axbridge (https://github.com/jx-grxf/axbridge) for this iOS app: add the AXBridge Swift package to the app target, wrap `import AXBridge` and `AXBridge.start(openURL:)` in `#if DEBUG` at launch with our deep-link handler, register the MCP server with `npx -y axbridge-mcp` for this agent, then build_and_run the app on a simulator and show me the first screen as text.
```

Or by hand:

**1. Add the Swift package to your app**

In Xcode: *File › Add Package Dependencies…* → `https://github.com/jx-grxf/axbridge`. Or in
`Package.swift`:

```swift
.package(url: "https://github.com/jx-grxf/axbridge", from: "0.2.0")
```

Start it once, as early as possible:

```swift
#if DEBUG
import AXBridge
#endif

@main
struct MyApp: App {
    init() {
        #if DEBUG
        AXBridge.start(openURL: { url in DeepLinkRouter.shared.open(url) })
        #endif
    }
    // …
}
```

`openURL` is optional; pass your deep-link handler so `go` reaches it directly. The bridge
runs only in Debug builds in the Simulator, and only starts when the app is launched by
axbridge. Release builds contain no code from the package, not even its type names, so the
`#if DEBUG` around the import and the call is required.

**2. Add the MCP server to your agent**

Claude Code:

```bash
claude mcp add axbridge -- npx -y axbridge-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.axbridge]
command = "npx"
args = ["-y", "axbridge-mcp"]
```

Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "axbridge": { "command": "npx", "args": ["-y", "axbridge-mcp"] } } }
```

Or let the CLI write the config: `npx axbridge-mcp setup claude` (also `codex`, `cursor`, `all`).
`npx axbridge-mcp doctor` checks Xcode, simulators and the installed version. More clients and
a ready-made agent prompt: [docs/AGENTS.md](docs/AGENTS.md).

## Requirements

- macOS with Xcode 15 or newer (`xcrun simctl` must work)
- Node.js 20 or newer
- iOS 15+ app, SwiftUI or UIKit

## Usage

Ask your agent in plain words, for example:

> Build the MyApp scheme, launch it fresh on the iPhone 17 simulator, sign up with a test
> email, and tell me whether the welcome screen shows the right name. Screenshot only if
> something looks off.

The agent will typically call `build_and_run`, then `tap` / `type` a handful of times and
report back. To skip onboarding, pass UserDefaults:

```json
{ "bundleId": "com.example.app", "defaults": { "onboardingDone": true } }
```

In the app, `AXBridge.isActive` tells you the agent launched it, for example to keep review
prompts closed.

## Limits

- Only what carries an accessibility label shows up as text. A missing label is also a
  VoiceOver bug, and the agent will notice it.
- Swipe gestures, maps and drag and drop need a coordinate tool or a screenshot.
- iOS Simulator only. Devices, watchOS and macOS apps are not supported yet.

## Development

```bash
swift test                    # Swift package (request parsing, auth)
cd mcp && npm install && npm test && npm run build
cd Example && xcodegen generate   # example app wired to the local package
```

[Example/](Example/) is a small SwiftUI app with tabs, a searchable list, navigation, a text
field and a sheet, used for end-to-end checks.

## License

MIT, see [LICENSE](LICENSE).
