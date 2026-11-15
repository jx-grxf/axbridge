# axbridge-mcp

MCP server for [axbridge](https://github.com/jx-grxf/axbridge): lets Claude Code, Codex,
Cursor and other MCP clients use an iOS app in the Simulator as text. It reads the screen
from the accessibility tree, taps by name, types, scrolls and goes back, and manages
simulators, builds, screenshots, recordings and visual diffs.

```bash
claude mcp add axbridge -- npx -y axbridge-mcp
```

The app under test needs the AXBridge Swift package and one call to `AXBridge.start()`.
Setup, the full tool list and measurements are in the
[main README](https://github.com/jx-grxf/axbridge#readme).

Requires macOS with Xcode and Node.js 20+. MIT licensed.
