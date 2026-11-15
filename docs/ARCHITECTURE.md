# How it works

```
┌──────────────┐  stdio (MCP)   ┌──────────────────┐   HTTP on 127.0.0.1:<port>   ┌──────────────────────┐
│ Agent        │ ─────────────▶ │ axbridge-mcp     │ ───────────────────────────▶ │ Your app (Debug,     │
│ Claude Code, │ ◀───────────── │ (Node, npx)      │ ◀─────────────────────────── │ Simulator)           │
│ Codex, Cursor│                │                  │   X-AXBridge-Token           │ AXBridge package     │
└──────────────┘                │ xcrun simctl     │                              │ reads the in-process │
                                │ xcodebuild, sips │                              │ accessibility tree   │
                                └──────────────────┘                              └──────────────────────┘
```

**In the app.** `AXBridge.start()` opens a small HTTP listener with Network.framework. On
`GET /screen` it walks the key window: accessibility elements first (that is where SwiftUI
exposes its content), then UIKit subviews (navigation bar, search field, tab bar). It keeps
elements that are visible and have a label or value, drops duplicates and prints one line
each. If a sheet is presented, it walks only the sheet.

Actions use what the element already supports: `accessibilityActivate()` for buttons and
rows, `becomeFirstResponder()` for text fields, the tab bar controller's delegate for tabs,
`UIControl.sendActions` as a fallback. Text is inserted with `UIKeyInput.insertText`, so no
keyboard is involved. `back` dismisses the top sheet or pops the deepest visible navigation
controller. `go` calls the handler you pass to `start(openURL:)`.

**In the MCP server.** `launch` turns on the Simulator's accessibility setting (SwiftUI only
builds its tree while it is on), picks a free port, creates a token, and starts the app with
`xcrun simctl launch` and `SIMCTL_CHILD_AXBRIDGE_PORT` / `SIMCTL_CHILD_AXBRIDGE_TOKEN`. It
then polls `/screen` until the first screen is there. Each simulator has its own session, so
several apps on several simulators can be driven in one conversation.

Screenshots come from `simctl io screenshot`. `sips` scales them down to a JPEG and, for
`element`, crops them to the element's frame, which the app reports in points together with
the screen scale. `compare` uses pixelmatch.

## Protocol

| Request | Body | Answer |
|---|---|---|
| `GET /screen` | | screen as text |
| `POST /tap` | target | new screen, `404` if not found, `202` with a point if the element cannot be activated |
| `POST /type` | text | new screen |
| `POST /clear` | | new screen |
| `POST /scroll` | `down`, `up`, `top`, `bottom`, `left`, `right` | new screen |
| `POST /back` | | new screen |
| `POST /go` | URL | new screen |
| `POST /frame` | target | `x y width height scale` |

Every request needs `X-AXBridge-Token` and must not carry `Origin`.
