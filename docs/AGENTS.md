# Agent setup

axbridge-mcp is a stdio MCP server started with `npx -y axbridge-mcp`. Any client that can
run a local MCP server works.

## Claude Code

```bash
claude mcp add axbridge -- npx -y axbridge-mcp            # for you, in every project
claude mcp add axbridge --scope project -- npx -y axbridge-mcp   # shared via .mcp.json
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.axbridge]
command = "npx"
args = ["-y", "axbridge-mcp"]
```

## Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "axbridge": { "command": "npx", "args": ["-y", "axbridge-mcp"] } } }
```

## Other clients (Claude Desktop, VS Code, Windsurf, Zed …)

Use the same command and arguments: `npx`, `["-y", "axbridge-mcp"]`. To keep screenshots
somewhere other than the system temp folder, set `AXBRIDGE_OUTPUT_DIR`.

## A paragraph for your agent instructions

Paste this into `CLAUDE.md`, `AGENTS.md` or `.cursor/rules` so the agent uses the tools well:

```markdown
## iOS Simulator

Use the axbridge MCP tools to check the app in the Simulator.
- Start with `build_and_run` (scheme <YourScheme>) or `launch` (bundle id <your.bundle.id>).
  Pass `defaults: { <yourOnboardingKey>: true }` to skip onboarding unless onboarding is
  what you are checking.
- Navigate and read with text: `tap`, `type`, `scroll`, `action` (swipe actions), `adjust`
  (sliders, steppers), `wait_for`, `back`, `go`. Each returns the new screen. Deep links:
  <list your app's routes>. `logs` shows recent app output when something looks wrong.
- Take a `screenshot` only to judge layout, colour or truncation; prefer `element` to crop.
- Check narrow and wide phones with `screenshots` on two or three simulators.
- Report what you saw, the path you took and the screenshot paths. Do not guess.
```

## Tips

- The app must wrap `import AXBridge` and `AXBridge.start(openURL:)` in `#if DEBUG`; Release
  builds contain no code from the package.
- Give elements in your app accessibility identifiers where labels are ambiguous; `tap`
  accepts `id:<identifier>`.
- Elements without a label do not show up in `screen`. That is a VoiceOver bug as well.
- `launch` with `reset: "fresh"` gives a clean first-run state without reinstalling.
- `status_bar`, `set_appearance` and `set_text_size` make screenshots repeatable.
