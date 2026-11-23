# Security

axbridge opens a TCP port inside your app so an agent on the same Mac can read and drive
its UI. These limits keep that port from becoming a problem:

- **Debug and Simulator only.** All server code sits behind
  `#if canImport(UIKit) && DEBUG && targetEnvironment(simulator)`. Release builds contain no
  code from the package at all, so the app wraps `import AXBridge` and `AXBridge.start` in
  `#if DEBUG`. On a physical device `start` does nothing.
- **Off unless asked.** The server starts only when the app is launched with `--axbridge`,
  which the MCP server passes. Launching from Xcode or the home screen does not start it.
- **Loopback only.** The listener binds to `127.0.0.1`.
- **Token per launch.** The MCP server generates a 192-bit random token for every launch and
  hands it to the app through the environment. Requests without it get `401`. Tokens are
  compared in constant time.
- **No browsers.** Requests that carry an `Origin` header are rejected, so a web page open
  on the same Mac cannot reach the port even if it guessed it.
- Session data (port and token per simulator) is kept in `~/.cache/axbridge/sessions.json`
  with mode `0600`.
- Local usage analytics (`~/.cache/axbridge/analytics.jsonl`, mode `0600`, never sent anywhere,
  off with `AXBRIDGE_NO_ANALYTICS=1`) record tool names, timings and error kinds. They never
  contain typed text, environment variables, push payloads or screen contents; deep links are
  reduced to scheme and host, error messages to their first line.

The bridge can do whatever a user of the app can do in the Simulator. Do not ship a build
that calls `AXBridge.start()` from a configuration that defines `DEBUG` to anyone.

## Reporting

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/jx-grxf/axbridge/security/advisories/new),
not in public issues.
