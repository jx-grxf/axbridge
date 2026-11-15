# Changelog

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
