import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  classifyError,
  countScreenElements,
  formatAnalyticsReport,
  readAnalyticsEvents,
  recordEvent,
  resetAnalytics,
  summarizeAnalytics,
} from "./analytics.js";
import { call, listSessions, sessionFor } from "./bridge.js";
import { ensureBooted, listDevices, openDeviceViewer, readSimulatorLogs, resolveDevice } from "./devices.js";
import { collectDoctorReport, formatDoctorLines } from "./doctor.js";
import { run, CommandError } from "./exec.js";
import {
  box,
  createStyler,
  dotBadge,
  errBadge,
  highlightScreen,
  okBadge,
  parseScreen,
  supportsColor,
  table,
  terminalWidth,
} from "./ui.js";
import { VERSION } from "./version.js";

const CLI_SESSION_ID = randomBytes(8).toString("hex");

const HELP = `axbridge ${VERSION}: drive iOS Simulator apps as text from coding agents

Usage
  npx axbridge-mcp                                  start the MCP server (stdio); used by agents
  npx axbridge-mcp tui [device]                     launch the interactive terminal UI
  npx axbridge-mcp doctor                           check macOS, Xcode, Device Hub/Simulator, sessions & analytics
  npx axbridge-mcp setup <claude|codex|cursor|all>  register the MCP server (--project for Cursor project config)
  npx axbridge-mcp devices [--all] [--json]         list simulators and active axbridge sessions
  npx axbridge-mcp boot <device> [--show]           boot simulator and optionally open Device Hub / Simulator
  npx axbridge-mcp screen [device] [--raw] [--json] print the current screen
  npx axbridge-mcp tap <target> [device]            tap an element by text, "#n", or "id:identifier"
  npx axbridge-mcp type <text> [--clear] [--submit] [device]
  npx axbridge-mcp scroll [dir] [--to <target>] [--max-swipes <n>] [device]
  npx axbridge-mcp action <target> <name> [device]  trigger custom accessibility action (e.g. Delete, Pin)
  npx axbridge-mcp adjust <target> <increment|decrement> [--steps <n>] [device]
  npx axbridge-mcp back [device]                    dismiss sheet or pop navigation
  npx axbridge-mcp go <url> [device]                open a deep link inside the app
  npx axbridge-mcp wait <target> [--disappear] [--timeout <ms>] [device]
  npx axbridge-mcp logs [device] [--last <sec>] [--lines <n>] [--bundle <id>] [--process <name>]
  npx axbridge-mcp analytics [--days <n>] [--json] [--reset]
  npx axbridge-mcp --version

Exit codes: 0 ok, 1 error, 2 element found but cannot be activated (use a coordinate tap).
Use -- before text that starts with dashes: axbridge type -- "--flag".

Docs: https://github.com/jx-grxf/axbridge`;

const SERVER = { command: "npx", args: ["-y", "axbridge-mcp"] };

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set(["--to", "--max-swipes", "--steps", "--timeout", "--last", "--lines", "--days", "--bundle", "--process"]);
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (literal) {
      positional.push(arg);
    } else if (arg === "--") {
      literal = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(0, eq)] = arg.slice(eq + 1);
      } else if (valueFlags.has(arg) && i + 1 < args.length) {
        flags[arg] = args[++i];
      } else {
        flags[arg] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new CommandError(`${key} needs a number`);
  return n;
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

async function has(cmd: string): Promise<boolean> {
  return run("/usr/bin/which", [cmd]).then(() => true, () => false);
}

async function doctor(): Promise<number> {
  const color = supportsColor();
  const s = createStyler(color);
  const report = await collectDoctorReport({ checkUpdates: true });
  const width = terminalWidth();
  const lines = formatDoctorLines(report.checks, { color, width: width - 4 });
  console.log(box(`axbridge ${report.version} doctor`, lines, { color, maxWidth: width }));
  if (report.failures) console.log(s.dim(`${report.failures} check${report.failures === 1 ? "" : "s"} failed.`));
  return report.failures ? 1 : 0;
}

async function setupClaude(): Promise<void> {
  const color = supportsColor();
  if (!(await has("claude"))) {
    console.log(`  ${errBadge(color)} claude CLI not found; run: claude mcp add axbridge --scope user -- npx -y axbridge-mcp`);
    return;
  }
  await run("claude", ["mcp", "remove", "axbridge", "--scope", "user"]).catch(() => undefined);
  await run("claude", ["mcp", "add", "axbridge", "--scope", "user", "--", ...[SERVER.command, ...SERVER.args]]);
  console.log(`  ${okBadge(color)} Claude Code: added for your user (all projects)`);
}

async function setupCodex(): Promise<void> {
  const color = supportsColor();
  const file = join(homedir(), ".codex", "config.toml");
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (/^\[mcp_servers\.axbridge\]/m.test(current)) {
    console.log(`  ${okBadge(color)} Codex: already in ${file}`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const block = `\n[mcp_servers.axbridge]\ncommand = "npx"\nargs = ["-y", "axbridge-mcp"]\n`;
  await writeFile(file, current.replace(/\n*$/, "\n") + block);
  console.log(`  ${okBadge(color)} Codex: added to ${file}`);
}

async function setupCursor(project: boolean): Promise<void> {
  const color = supportsColor();
  const file = project ? join(process.cwd(), ".cursor", "mcp.json") : join(homedir(), ".cursor", "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {
      console.log(`  ${errBadge(color)} Cursor: ${file} is not valid JSON, left unchanged`);
      return;
    }
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), axbridge: SERVER };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`  ${okBadge(color)} Cursor: written to ${file}`);
}

async function setup(agent: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const color = supportsColor();
  const s = createStyler(color);
  const targets = agent === "all" ? ["claude", "codex", "cursor"] : agent ? [agent] : [];
  if (targets.length === 0 || targets.some((t) => !["claude", "codex", "cursor"].includes(t))) {
    console.log("Usage: npx axbridge-mcp setup claude|codex|cursor|all [--project]");
    return 1;
  }
  console.log(s.bold("axbridge MCP setup"));
  for (const t of targets) {
    if (t === "claude") await setupClaude();
    if (t === "codex") await setupCodex();
    if (t === "cursor") await setupCursor(Boolean(flags["--project"]));
  }
  console.log(`\n${s.dim("Next: add the AXBridge Swift package to your app and call AXBridge.start().")}`);
  return 0;
}

async function devicesCmd(flags: Record<string, string | boolean>): Promise<number> {
  const showAll = Boolean(flags["--all"]);
  const asJson = Boolean(flags["--json"]);
  const allDevices = await listDevices();
  const sessions = await listSessions();
  const sessMap = new Map(sessions.map((s) => [s.udid, s]));
  const list = allDevices
    .filter((d) => showAll || d.available)
    .sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || a.name.localeCompare(b.name));

  if (asJson) {
    console.log(JSON.stringify(list.map((d) => ({ ...d, session: sessMap.get(d.udid) ?? null })), null, 2));
    return 0;
  }

  const color = supportsColor();
  const s = createStyler(color);
  const rows = list.map((d) => {
    const sess = sessMap.get(d.udid);
    const status = `${dotBadge(d.state === "Booted", color)} ${d.state === "Booted" ? s.green(d.state) : s.dim(d.state)}`;
    const bridge = sess ? s.cyan(`${sess.bundleId} :${sess.port}`) : s.dim("-");
    return [s.bold(d.name), d.runtime, status, bridge, s.dim(d.udid)];
  });
  console.log(table(["Device", "Runtime", "State", "Bridge Session", "UDID"], rows, { color }));
  return 0;
}

async function bootCmd(deviceQuery: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!deviceQuery) throw new CommandError("Usage: axbridge boot <device> [--show]");
  const d = await resolveDevice(deviceQuery);
  await ensureBooted(d);
  let viewerNote = "";
  if (flags["--show"]) {
    const viewer = await openDeviceViewer(d.udid);
    viewerNote = ` (${viewer.name} opened)`;
  }
  const color = supportsColor();
  console.log(`${okBadge(color)} booted: ${d.name} (${d.runtime}) ${d.udid}${viewerNote}`);
  return 0;
}

async function bridgeCallCli(
  deviceQuery: string | undefined,
  method: "GET" | "POST",
  path: string,
  body = "",
  opts: { timeoutMs?: number; headers?: Record<string, string>; raw?: boolean; json?: boolean } = {},
): Promise<{ status: number; text: string }> {
  const d = await resolveDevice(deviceQuery);
  const reply = await call(await sessionFor(d.udid), method, path, body, opts.timeoutMs, opts.headers);
  if (reply.status >= 400) throw new CommandError(reply.text);
  if (opts.json) {
    console.log(JSON.stringify(parseScreen(reply.text), null, 2));
  } else if (opts.raw) {
    console.log(reply.text);
  } else {
    console.log(highlightScreen(reply.text));
  }
  if (reply.status === 202) {
    console.log("(Cannot activate element directly; use a coordinate tap.)");
  }
  return reply;
}

async function analyticsCmd(flags: Record<string, string | boolean>): Promise<number> {
  if (flags["--reset"]) {
    await resetAnalytics();
    console.log("Local analytics cleared.");
    return 0;
  }
  const days = numFlag(flags, "--days");
  const events = await readAnalyticsEvents({ days });
  const summary = summarizeAnalytics(events, { days });
  if (flags["--json"]) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatAnalyticsReport(summary));
  }
  return 0;
}

async function trackedCli(
  tool: string,
  fn: () => Promise<{ text?: string; status?: number } | number>,
  meta: { target?: string; device?: string; bundleId?: string } = {},
): Promise<number> {
  const start = Date.now();
  try {
    const res = await fn();
    const durationMs = Date.now() - start;
    const text = typeof res === "number" ? "" : (res.text ?? "");
    const status = typeof res === "number" ? res : (res.status ?? 200);
    const cannotActivate = status === 202;
    await recordEvent({
      ts: new Date().toISOString(),
      sessionId: CLI_SESSION_ID,
      source: "cli",
      tool,
      durationMs,
      ok: !cannotActivate && (typeof res !== "number" || res === 0),
      ...(cannotActivate ? { errorKind: "cannot_activate" as const, error: text } : {}),
      device: meta.device,
      bundleId: meta.bundleId,
      target: meta.target,
      elementCount: text ? countScreenElements(text) : undefined,
      outputChars: text ? text.length : undefined,
    });
    return typeof res === "number" ? res : cannotActivate ? 2 : 0;
  } catch (error) {
    const message = (error as Error).message || String(error);
    await recordEvent({
      ts: new Date().toISOString(),
      sessionId: CLI_SESSION_ID,
      source: "cli",
      tool,
      durationMs: Date.now() - start,
      ok: false,
      errorKind: classifyError(message),
      error: message,
      device: meta.device,
      bundleId: meta.bundleId,
      target: meta.target,
    });
    throw error;
  }
}

export async function runCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  try {
    switch (command) {
      case "--version":
      case "-v":
      case "version":
        console.log(VERSION);
        return 0;
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      case "tui": {
        const { runTui } = await import("./tui.js");
        return await runTui(positional[0]);
      }
      case "doctor":
        return await doctor();
      case "setup":
        return await setup(positional[0], flags);
      case "devices":
        return await devicesCmd(flags);
      case "boot":
        return await trackedCli("boot", () => bootCmd(positional[0], flags), { device: positional[0] });
      case "screen":
        return await trackedCli(
          "screen",
          () => bridgeCallCli(positional[0], "GET", "/screen", "", { raw: Boolean(flags["--raw"]), json: Boolean(flags["--json"]) }),
          { device: positional[0] },
        );
      case "tap": {
        const [target, device] = positional;
        if (!target) throw new CommandError("Usage: axbridge tap <target> [device]");
        return await trackedCli("tap", () => bridgeCallCli(device, "POST", "/tap", target), { target, device });
      }
      case "type": {
        const [value, device] = positional;
        if (value === undefined) throw new CommandError("Usage: axbridge type <text> [--clear] [--submit] [device]");
        return await trackedCli(
          "type",
          async () => {
            if (flags["--clear"]) {
              const d = await resolveDevice(device);
              const cleared = await call(await sessionFor(d.udid), "POST", "/clear");
              if (cleared.status >= 400) throw new CommandError(cleared.text);
            }
            return bridgeCallCli(device, "POST", "/type", value, {
              headers: flags["--submit"] ? { "X-AXBridge-Submit": "1" } : undefined,
            });
          },
          { device },
        );
      }
      case "scroll": {
        const directions = new Set(["down", "up", "top", "bottom", "left", "right"]);
        const target = strFlag(flags, "--to");
        const maxSwipes = numFlag(flags, "--max-swipes");
        let direction = "down";
        let device: string | undefined;
        if (positional.length === 1 && !directions.has(positional[0].toLowerCase())) {
          device = positional[0];
        } else {
          direction = (positional[0] ?? "down").toLowerCase();
          device = positional[1];
          if (!directions.has(direction)) {
            throw new CommandError(`Unknown direction "${direction}". Use down, up, top, bottom, left or right.`);
          }
        }
        return await trackedCli(
          "scroll",
          () =>
            target
              ? bridgeCallCli(
                  device,
                  "POST",
                  "/scroll",
                  JSON.stringify({ direction, target, maxSwipes: maxSwipes ?? 8 }),
                  { headers: { "Content-Type": "application/json" } },
                )
              : bridgeCallCli(device, "POST", "/scroll", direction),
          { target, device },
        );
      }
      case "action": {
        const [target, actionName, device] = positional;
        if (!target || !actionName) throw new CommandError("Usage: axbridge action <target> <actionName> [device]");
        return await trackedCli(
          "action",
          () =>
            bridgeCallCli(device, "POST", "/action", JSON.stringify({ target, action: actionName }), {
              headers: { "Content-Type": "application/json" },
            }),
          { target, device },
        );
      }
      case "adjust": {
        const [target, direction, device] = positional;
        if (!target || (direction !== "increment" && direction !== "decrement")) {
          throw new CommandError("Usage: axbridge adjust <target> <increment|decrement> [--steps <n>] [device]");
        }
        const steps = numFlag(flags, "--steps") ?? 1;
        return await trackedCli(
          "adjust",
          () =>
            bridgeCallCli(device, "POST", "/adjust", JSON.stringify({ target, direction, steps }), {
              headers: { "Content-Type": "application/json" },
            }),
          { target, device },
        );
      }
      case "back":
        return await trackedCli("back", () => bridgeCallCli(positional[0], "POST", "/back"), { device: positional[0] });
      case "go": {
        const [url, device] = positional;
        if (!url) throw new CommandError("Usage: axbridge go <url> [device]");
        return await trackedCli("go", () => bridgeCallCli(device, "POST", "/go", url), { target: url, device });
      }
      case "wait": {
        const [target, device] = positional;
        if (!target) throw new CommandError("Usage: axbridge wait <target> [--disappear] [--timeout <ms>] [device]");
        const state = flags["--disappear"] ? "disappear" : "appear";
        const timeoutMs = numFlag(flags, "--timeout") ?? 10_000;
        return await trackedCli(
          "wait_for",
          () =>
            bridgeCallCli(device, "POST", "/wait", JSON.stringify({ target, state, timeoutMs }), {
              timeoutMs: timeoutMs + 5_000,
              headers: { "Content-Type": "application/json" },
            }),
          { target, device },
        );
      }
      case "logs": {
        const device = positional[0];
        const seconds = numFlag(flags, "--last") ?? 30;
        const lines = numFlag(flags, "--lines") ?? 80;
        const bundleId = strFlag(flags, "--bundle");
        const proc = strFlag(flags, "--process");
        return await trackedCli(
          "logs",
          async () => {
            const d = await resolveDevice(device);
            const activeBundle = !bundleId && !proc ? (await listSessions()).find((s) => s.udid === d.udid)?.bundleId : bundleId;
            const out = await readSimulatorLogs(d.udid, { bundleId: activeBundle, process: proc, seconds, lines });
            console.log(out);
            return { text: out };
          },
          { device, bundleId },
        );
      }
      case "analytics":
        return await analyticsCmd(flags);
      default:
        console.error(`Unknown command "${command}".\n`);
        console.error(HELP);
        return 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
