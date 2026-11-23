#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { background, flushStdio, run, simctl, sleep, CommandError } from "./exec.js";
import {
  listDevices,
  resolveDevice,
  ensureBooted,
  openDeviceViewer,
  readSimulatorLogs,
  type Device,
} from "./devices.js";
import { newSession, sessionFor, listSessions, call } from "./bridge.js";
import { screenshot, compare, OUTPUT_DIR } from "./images.js";
import { buildForSimulator, bundleIdOf } from "./build.js";
import { VERSION, newerVersion, updateHint } from "./version.js";
import {
  classifyError,
  countScreenElements,
  formatAnalyticsReport,
  readAnalyticsEvents,
  recordEvent,
  resetAnalytics,
  summarizeAnalytics,
} from "./analytics.js";

if (process.argv.length > 2) {
  const { runCli } = await import("./cli.js");
  const code = await runCli(process.argv.slice(2));
  await flushStdio();
  process.exit(code);
}

// Start from the cached answer so the handshake never waits for the network; the refresh
// below updates `latest` for the tool results of this session and the next start.
let latest = await newerVersion(0, { cacheOnly: true });
void newerVersion().then((fresh) => {
  latest = fresh ?? latest;
});
const SESSION_ID = randomBytes(8).toString("hex");

const INSTRUCTIONS = `axbridge drives iOS Simulator apps as text.
Workflow: \`launch\` (or \`build_and_run\`) starts the app with the bridge and returns the screen as text.
Then use \`tap\`, \`type\`, \`scroll\`, \`action\`, \`adjust\`, \`wait_for\`, \`back\`, \`go\`; each returns the new screen as text, so \`screen\` is rarely needed.
Targets for tap/action/adjust: exact or partial label/value text, "#3" (number from the last listing) or "id:identifier".
Use \`screenshot\` only to judge visuals; pass \`element\` to crop to one element. Several devices can run at once:
pass \`device\` (name, UDID or "booted") to every call.${latest ? `\n\n${updateHint(latest)}` : ""}`;

const server = new McpServer({ name: "axbridge", version: VERSION }, { instructions: INSTRUCTIONS });
let updateMentioned = false;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; _cannotActivate?: boolean };

function text(t: string): ToolResult {
  return { content: [{ type: "text" as const, text: t }] };
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
    const start = Date.now();
    const recordArgs = args as Record<string, unknown>;
    const deviceArg = typeof recordArgs.device === "string" ? recordArgs.device : undefined;
    const bundleArg = typeof recordArgs.bundleId === "string" ? recordArgs.bundleId : undefined;
    // Never log typed text, env vars, or push payloads — only safe target identifiers.
    const targetArg =
      typeof recordArgs.target === "string"
        ? recordArgs.target
        : typeof recordArgs.element === "string"
          ? recordArgs.element
          : undefined;

    try {
      const rawResult = await handler(args);
      const cannotActivate = Boolean(rawResult._cannotActivate);
      const result: { content: Content[] } = { content: rawResult.content };
      if (latest && !updateMentioned) {
        updateMentioned = true;
        result.content.push({ type: "text", text: `\n${updateHint(latest)}` });
      }
      const textOut = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      await recordEvent({
        ts: new Date().toISOString(),
        sessionId: SESSION_ID,
        source: "mcp",
        tool: name,
        durationMs: Date.now() - start,
        ok: !cannotActivate,
        ...(cannotActivate ? { errorKind: "cannot_activate" as const, error: textOut } : {}),
        device: deviceArg,
        bundleId: bundleArg,
        target: targetArg,
        elementCount: countScreenElements(textOut),
        outputChars: textOut.length,
      });

      return result;
    } catch (error) {
      const message = (error as Error).message || String(error);
      await recordEvent({
        ts: new Date().toISOString(),
        sessionId: SESSION_ID,
        source: "mcp",
        tool: name,
        durationMs: Date.now() - start,
        ok: false,
        errorKind: classifyError(message),
        error: message,
        device: deviceArg,
        bundleId: bundleArg,
        target: targetArg,
      });
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  }) as never);
}

const device = z.string().optional().describe('Simulator name, UDID or "booted" (default). Required when several are booted.');

function describeDevice(d: Device): string {
  return `${d.name} (${d.runtime}) ${d.udid} ${d.state}`;
}

async function bootedDevice(query?: string): Promise<Device> {
  const d = await resolveDevice(query);
  await ensureBooted(d);
  return d;
}

// MARK: Devices

tool("devices", "List simulators with name, runtime, UDID and state. Booted ones first.", {
  all: z.boolean().optional().describe("Include unavailable devices"),
}, async ({ all }) => {
  const list = (await listDevices())
    .filter((d) => all || d.available)
    .sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || a.name.localeCompare(b.name));
  return text(list.map(describeDevice).join("\n") || "no simulators");
});

tool("boot", "Boot a simulator and wait until it is ready. Optionally open Device Hub or Simulator.app to watch.", {
  device: z.string().describe("Name or UDID"),
  show: z.boolean().optional().describe("Open Device Hub (Xcode 27+) or Simulator.app"),
}, async ({ device: query, show }) => {
  const d = await bootedDevice(query);
  let viewerNote = "";
  if (show) {
    const viewer = await openDeviceViewer(d.udid);
    viewerNote = ` (${viewer.name} opened)`;
  }
  return text(`booted: ${describeDevice({ ...d, state: "Booted" })}${viewerNote}`);
});

tool("shutdown", 'Shut down a simulator, or every booted one with device "all".', { device }, async ({ device: query }) => {
  if (query === "all") {
    await simctl(["shutdown", "all"]);
    return text("all simulators shut down");
  }
  const d = await resolveDevice(query);
  await simctl(["shutdown", d.udid]);
  return text(`shut down: ${d.name}`);
});

tool("create_device", 'Create a simulator, e.g. name "Test 13 mini", type "iPhone 13 mini". Runtime defaults to the newest iOS.', {
  name: z.string(),
  type: z.string().describe('Device type name as in `xcrun simctl list devicetypes`, e.g. "iPhone 17"'),
  runtime: z.string().optional().describe('e.g. "iOS 27.2"; newest iOS when omitted'),
}, async ({ name, type, runtime }) => {
  const raw = JSON.parse(await simctl(["list", "runtimes", "--json"])) as {
    runtimes: Array<{ identifier: string; name: string; isAvailable: boolean; platform?: string }>;
  };
  const ios = raw.runtimes.filter((r) => r.isAvailable && r.name.startsWith("iOS"));
  const chosen = runtime ? ios.find((r) => r.name === runtime) : ios[ios.length - 1];
  if (!chosen) throw new CommandError(`No iOS runtime "${runtime}". Available: ${ios.map((r) => r.name).join(", ")}`);
  const udid = await simctl(["create", name, type, chosen.identifier]);
  return text(`created ${name} (${type}, ${chosen.name}) ${udid}`);
});

// MARK: App lifecycle

const launchShape = {
  device,
  reset: z.enum(["keep", "fresh"]).optional().describe("fresh deletes the app's data first, like a new install"),
  args: z.array(z.string()).optional().describe("Extra launch arguments"),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables for the app"),
  defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    .describe("UserDefaults to write before launch, e.g. to mark onboarding as done"),
};

async function launchApp(d: Device, bundleId: string, opts: {
  reset?: "keep" | "fresh"; args?: string[]; env?: Record<string, string>; defaults?: Record<string, string | number | boolean>;
}): Promise<string> {
  // SwiftUI only builds its accessibility tree while accessibility is on.
  for (const key of ["ApplicationAccessibilityEnabled", "AutomationEnabled"]) {
    await simctl(["spawn", d.udid, "defaults", "write", "com.apple.Accessibility", key, "-bool", "true"]);
  }
  // The swipe-typing tutorial covers half the screen the first time a field is focused.
  for (const domain of ["com.apple.Preferences", "com.apple.keyboard.preferences"]) {
    await simctl(["spawn", d.udid, "defaults", "write", domain, "DidShowContinuousPathIntroduction", "-bool", "true"]);
  }
  await simctl(["terminate", d.udid, bundleId]).catch(() => undefined);
  if (opts.reset === "fresh") {
    const data = await simctl(["get_app_container", d.udid, bundleId, "data"]);
    await run("/bin/rm", ["-rf", join(data, "Library"), join(data, "Documents"), join(data, "tmp")]);
  }
  for (const [key, value] of Object.entries(opts.defaults ?? {})) {
    const kind = typeof value === "boolean" ? "-bool" : typeof value === "number" ? (Number.isInteger(value) ? "-int" : "-float") : "-string";
    await simctl(["spawn", d.udid, "defaults", "write", bundleId, key, kind, String(value)]);
  }
  const session = await newSession(d.udid, bundleId);
  const env: NodeJS.ProcessEnv = { ...process.env, SIMCTL_CHILD_AXBRIDGE_PORT: String(session.port), SIMCTL_CHILD_AXBRIDGE_TOKEN: session.token };
  for (const [k, v] of Object.entries(opts.env ?? {})) env[`SIMCTL_CHILD_${k}`] = v;
  await simctl(["launch", "--terminate-running-process", d.udid, bundleId, "--axbridge", ...(opts.args ?? [])], { env });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const reply = await call(session, "GET", "/screen", "", 2_000);
      if (reply.status === 200 && !reply.text.startsWith("(empty")) return `${bundleId} running on ${d.name}\n\n${reply.text}`;
    } catch {
      // still launching
    }
    await sleep(700);
  }
  throw new CommandError(`${bundleId} launched on ${d.name}, but the bridge did not answer within 30 s. Is AXBridge.start() called in a Debug build?`);
}

tool("launch", "Launch an installed app with the bridge and return its first screen as text.", {
  bundleId: z.string(), ...launchShape,
}, async ({ device: query, bundleId, ...opts }) => text(await launchApp(await bootedDevice(query), bundleId, opts)));

tool("build_and_run", "Build an Xcode scheme for the simulator (Debug), install and launch it with the bridge.", {
  project: z.string().optional().describe(".xcodeproj path"),
  workspace: z.string().optional().describe(".xcworkspace path"),
  scheme: z.string(),
  configuration: z.string().optional().describe("Default Debug; the bridge exists only in Debug"),
  ...launchShape,
}, async ({ device: query, project, workspace, scheme, configuration, ...opts }) => {
  const d = await bootedDevice(query);
  const built = await buildForSimulator({ project, workspace, scheme, udid: d.udid, configuration: configuration ?? "Debug" });
  await simctl(["install", d.udid, built.appPath]);
  return text(await launchApp(d, built.bundleId, opts));
});

tool("install", "Install a .app bundle built for the simulator.", { device, appPath: z.string() }, async ({ device: query, appPath }) => {
  const d = await bootedDevice(query);
  await simctl(["install", d.udid, appPath]);
  return text(`installed ${await bundleIdOf(appPath)} on ${d.name}`);
});

tool("terminate", "Quit an app.", { device, bundleId: z.string() }, async ({ device: query, bundleId }) => {
  const d = await resolveDevice(query);
  await simctl(["terminate", d.udid, bundleId]);
  return text(`terminated ${bundleId}`);
});

tool("uninstall", "Remove an app and its data.", { device, bundleId: z.string() }, async ({ device: query, bundleId }) => {
  const d = await resolveDevice(query);
  await simctl(["uninstall", d.udid, bundleId]);
  return text(`uninstalled ${bundleId}`);
});

// MARK: Reading and acting as text

async function bridgeCall(
  query: string | undefined,
  method: "GET" | "POST",
  path: string,
  body = "",
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<ToolResult> {
  const d = await resolveDevice(query);
  const reply = await call(await sessionFor(d.udid), method, path, body, opts.timeoutMs, opts.headers);
  if (reply.status === 202) {
    return {
      content: [{ type: "text" as const, text: `${reply.text}\n(Use a coordinate tap from another tool for this element.)` }],
      _cannotActivate: true,
    };
  }
  if (reply.status >= 400) throw new CommandError(reply.text);
  return text(reply.text);
}

tool("screen", "The current screen as text: number, kind, label = value, id, actions, centre point.", { device },
  ({ device: q }) => bridgeCall(q, "GET", "/screen"));

tool("tap", 'Activate an element by text, "#n" from the last listing or "id:identifier". Returns the new screen.', {
  target: z.string(), device,
}, ({ target, device: q }) => bridgeCall(q, "POST", "/tap", target));

tool("type", "Insert text into the focused field (tap it first). No keyboard needed; any characters work.", {
  text: z.string(),
  clear: z.boolean().optional().describe("Empty the field first"),
  submit: z.boolean().optional().describe("Press Return/Search after typing"),
  device,
}, async ({ text: value, clear, submit, device: q }) => {
  if (clear) await bridgeCall(q, "POST", "/clear");
  return bridgeCall(q, "POST", "/type", value, {
    headers: submit ? { "X-AXBridge-Submit": "1" } : undefined,
  });
});

tool("scroll", "Scroll the main scroll view, or scroll until a target element becomes visible.", {
  direction: z.enum(["down", "up", "top", "bottom", "left", "right"]).optional(),
  target: z.string().optional().describe("Scroll until this element becomes visible"),
  maxSwipes: z.number().int().min(1).max(25).optional(),
  device,
}, ({ direction, target, maxSwipes, device: q }) => {
  if (target) {
    return bridgeCall(
      q,
      "POST",
      "/scroll",
      JSON.stringify({ direction: direction ?? "down", target, maxSwipes: maxSwipes ?? 8 }),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  return bridgeCall(q, "POST", "/scroll", direction ?? "down");
});

tool("action", "Trigger a custom accessibility action on an element (e.g. SwiftUI .swipeActions like Delete or Pin).", {
  target: z.string().describe('Element by text, "#n", or "id:identifier"'),
  action: z.string().describe("Action name as listed in actions:[...]"),
  device,
}, ({ target, action, device: q }) =>
  bridgeCall(q, "POST", "/action", JSON.stringify({ target, action }), {
    headers: { "Content-Type": "application/json" },
  }),
);

tool("adjust", "Increment or decrement an adjustable control (Slider, Stepper, Picker).", {
  target: z.string().describe('Element by text, "#n", or "id:identifier"'),
  direction: z.enum(["increment", "decrement"]),
  steps: z.number().int().min(1).max(20).optional().describe("Number of adjustment steps (default 1)"),
  device,
}, ({ target, direction, steps, device: q }) =>
  bridgeCall(q, "POST", "/adjust", JSON.stringify({ target, direction, steps: steps ?? 1 }), {
    headers: { "Content-Type": "application/json" },
  }),
);

tool("wait_for", "Wait for an element or text to appear or disappear on screen.", {
  target: z.string().describe('Element by text, "#n", or "id:identifier"'),
  state: z.enum(["appear", "disappear"]).optional().describe("Default appear"),
  timeoutMs: z.number().int().min(200).max(60_000).optional().describe("Timeout in ms (default 10000)"),
  device,
}, ({ target, state, timeoutMs, device: q }) => {
  const waitMs = timeoutMs ?? 10_000;
  return bridgeCall(
    q,
    "POST",
    "/wait",
    JSON.stringify({ target, state: state ?? "appear", timeoutMs: waitMs }),
    { timeoutMs: waitMs + 5_000, headers: { "Content-Type": "application/json" } },
  );
});

tool("back", "Close the top sheet, or pop the navigation stack.", { device }, ({ device: q }) => bridgeCall(q, "POST", "/back"));

tool("go", "Open a deep link inside the app (no system prompt when the app passes openURL to AXBridge.start).", {
  url: z.string(), device,
}, ({ url, device: q }) => bridgeCall(q, "POST", "/go", url));

// MARK: Device state & logs

tool("logs", "Read recent simulator logs for an app or process (crashes, console output, errors).", {
  bundleId: z.string().optional().describe("Filter logs by bundle identifier (defaults to active axbridge session)"),
  process: z.string().optional().describe("Filter logs by process name"),
  seconds: z.number().int().min(1).max(3600).optional().describe("Lookback window in seconds (default 30)"),
  lines: z.number().int().min(1).max(500).optional().describe("Maximum lines to return (default 80)"),
  device,
}, async ({ bundleId, process: proc, seconds, lines, device: q }) => {
  const d = await resolveDevice(q);
  const activeBundle = !bundleId && !proc ? (await listSessions()).find((s) => s.udid === d.udid)?.bundleId : bundleId;
  const output = await readSimulatorLogs(d.udid, { bundleId: activeBundle, process: proc, seconds, lines });
  return text(output);
});

tool("set_location", "Set the simulated GPS position.", {
  latitude: z.number(), longitude: z.number(), device,
}, async ({ latitude, longitude, device: q }) => {
  const d = await bootedDevice(q);
  await simctl(["location", d.udid, "set", `${latitude},${longitude}`]);
  return text(`location ${latitude},${longitude} on ${d.name}`);
});

tool("set_appearance", "Switch light or dark mode.", { mode: z.enum(["light", "dark"]), device }, async ({ mode, device: q }) => {
  const d = await bootedDevice(q);
  await simctl(["ui", d.udid, "appearance", mode]);
  return text(`${mode} mode on ${d.name}`);
});

const TEXT_SIZES = [
  "extra-small", "small", "medium", "large", "extra-large", "extra-extra-large", "extra-extra-extra-large",
  "accessibility-medium", "accessibility-large", "accessibility-extra-large", "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

tool("set_text_size", "Set Dynamic Type. large is the default; accessibility-* are the largest.", {
  size: z.enum(TEXT_SIZES), device,
}, async ({ size, device: q }) => {
  const d = await bootedDevice(q);
  await simctl(["ui", d.udid, "content_size", size]);
  return text(`text size ${size} on ${d.name}`);
});

tool("status_bar", "Clean status bar for screenshots (9:41, full battery and signal), or clear the override.", {
  clear: z.boolean().optional(), time: z.string().optional().describe('Default "9:41"'), device,
}, async ({ clear, time, device: q }) => {
  const d = await bootedDevice(q);
  if (clear) {
    await simctl(["status_bar", d.udid, "clear"]);
    return text("status bar override cleared");
  }
  await simctl(["status_bar", d.udid, "override", "--time", time ?? "9:41", "--batteryState", "charged", "--batteryLevel", "100",
    "--cellularMode", "active", "--cellularBars", "4", "--wifiBars", "3", "--dataNetwork", "wifi"]);
  return text(`status bar ${time ?? "9:41"} on ${d.name}`);
});

tool("permission", "Grant, revoke or reset a privacy permission without the system prompt.", {
  bundleId: z.string(),
  action: z.enum(["grant", "revoke", "reset"]),
  service: z.enum(["all", "calendar", "contacts-limited", "contacts", "location", "location-always", "photos-add", "photos",
    "media-library", "microphone", "motion", "reminders", "siri", "camera", "notifications"]),
  device,
}, async ({ bundleId, action, service, device: q }) => {
  const d = await bootedDevice(q);
  await simctl(["privacy", d.udid, action, service, bundleId]);
  return text(`${action} ${service} for ${bundleId}`);
});

tool("push", "Deliver a push notification payload to the app.", {
  bundleId: z.string(), payload: z.record(z.string(), z.unknown()).describe('APNs JSON, e.g. {"aps":{"alert":"Hello"}}'), device,
}, async ({ bundleId, payload, device: q }) => {
  const d = await bootedDevice(q);
  const dir = await mkdtemp(join(tmpdir(), "axbridge-push-"));
  try {
    const file = join(dir, "payload.json");
    await writeFile(file, JSON.stringify(payload));
    await simctl(["push", d.udid, bundleId, file]);
    return text(`push delivered to ${bundleId}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// MARK: Images

tool("screenshot", "Screenshot as a small JPEG for visual checks. element crops to one element; the full PNG path is returned too.", {
  device,
  element: z.string().optional().describe("Crop to this element (same targets as tap)"),
  width: z.number().int().min(200).max(1600).optional().describe("Pixel width of the returned image, default 500"),
  name: z.string().optional().describe("File name stem"),
}, async ({ device: q, element, width, name }) => {
  const d = await bootedDevice(q);
  let crop;
  if (element) {
    const reply = await call(await sessionFor(d.udid), "POST", "/frame", element);
    if (reply.status !== 200) throw new CommandError(reply.text);
    const [x, y, w, h, scale] = reply.text.split(" ").map(Number);
    crop = { x, y, w, h, scale };
  }
  const shot = await screenshot(d.udid, { name, width: width ?? 500, crop });
  return { content: [{ type: "image", data: shot.data, mimeType: "image/jpeg" }, { type: "text", text: `full: ${shot.full}` }] };
});

tool("screenshots", "The same moment on several simulators, e.g. to compare layouts across widths.", {
  devices: z.array(z.string()).min(1).max(6), width: z.number().int().min(200).max(1000).optional(),
}, async ({ devices: queries, width }) => {
  const content: Content[] = [];
  for (const q of queries) {
    const d = await bootedDevice(q);
    const shot = await screenshot(d.udid, { name: `${d.name}-${Date.now()}`, width: width ?? 400 });
    content.push({ type: "text", text: `${d.name}: ${shot.full}` }, { type: "image", data: shot.data, mimeType: "image/jpeg" });
  }
  return { content };
});

const recordings = new Map<string, { process: ChildProcess; path: string }>();
process.on("exit", () => {
  for (const rec of recordings.values()) rec.process.kill("SIGINT");
});

tool("record_start", "Start a screen recording (H.264 .mov).", { device }, async ({ device: q }) => {
  const d = await bootedDevice(q);
  if (recordings.has(d.udid)) throw new CommandError(`Already recording ${d.name}`);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${d.name.replace(/\W+/g, "-")}-${Date.now()}.mov`);
  const process = background("xcrun", ["simctl", "io", d.udid, "recordVideo", "--codec=h264", "--force", path]);
  recordings.set(d.udid, { process, path });
  return text(`recording ${d.name} → ${path}`);
});

tool("record_stop", "Stop the recording and return the file path.", { device }, async ({ device: q }) => {
  const d = await resolveDevice(q);
  const rec = recordings.get(d.udid);
  if (!rec) throw new CommandError(`No recording running on ${d.name}`);
  recordings.delete(d.udid);
  const finished = rec.process.exitCode !== null || rec.process.signalCode !== null;
  if (!finished) {
    const exited = new Promise((r) => rec.process.once("exit", r));
    rec.process.kill("SIGINT");
    await Promise.race([exited, sleep(15_000)]);
  }
  const saved = await stat(rec.path).then((s) => s.size > 0, () => false);
  if (!saved) throw new CommandError(`The recording on ${d.name} produced no file. Is the simulator booted?`);
  return text(`saved ${rec.path}`);
});

tool("compare", "Pixel-compare the current screen (or an image file) with a reference PNG. Returns the share of differing pixels and a diff image.", {
  reference: z.string().describe("Reference PNG path"),
  actual: z.string().optional().describe("PNG path; takes a fresh screenshot of device when omitted"),
  threshold: z.number().min(0).max(1).optional().describe("Per-pixel colour tolerance, default 0.1"),
  device,
}, async ({ reference, actual, threshold, device: q }) => {
  let actualPath = actual;
  if (!actualPath) {
    const d = await bootedDevice(q);
    actualPath = (await screenshot(d.udid, { width: 400 })).full;
  }
  const result = await compare(actualPath, reference, threshold ?? 0.1);
  return text(`${result.diffPercent}% of pixels differ (${result.diffPixels}). Diff image: ${result.diffImage}`);
});

// MARK: Analytics & Updates

tool("analytics", "View local axbridge usage analytics, latency metrics, token savings, and improvement suggestions.", {
  days: z.number().int().min(1).max(365).optional().describe("Limit summary to last N days"),
  reset: z.boolean().optional().describe("Clear recorded local analytics"),
}, async ({ days, reset }) => {
  if (reset) {
    await resetAnalytics();
    return text("Local analytics cleared.");
  }
  const events = await readAnalyticsEvents({ days });
  const summary = summarizeAnalytics(events, { days });
  return text(formatAnalyticsReport(summary, { color: false }));
});

async function findPins(root: string, depth = 0, found: string[] = []): Promise<string[]> {
  if (depth > 5 || found.length > 20) return found;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".mcp.json" && entry.name !== ".cursor" && entry.name !== ".codex") continue;
    if (["node_modules", "DerivedData", "build", "Pods", ".build"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await findPins(path, depth + 1, found);
    } else if (/^(Package\.swift|Package\.resolved|project\.yml|project\.pbxproj|\.mcp\.json|mcp\.json|config\.toml)$/.test(entry.name)) {
      const lines = (await readFile(path, "utf8").catch(() => "")).split("\n");
      lines.forEach((line, i) => {
        if (/axbridge/i.test(line) && /\d+\.\d+\.\d+|revision|version/i.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return found;
}

tool("update", "Check for a newer axbridge, preload it for npx and list where the app and agent configs pin a version.", {
  project: z.string().optional().describe("App repository to search for version pins (Package.swift, Package.resolved, project.yml, MCP configs)"),
}, async ({ project }) => {
  const newest = await newerVersion(5000);
  const lines: string[] = [];
  if (!newest) {
    lines.push(`axbridge-mcp ${VERSION} is the newest version (or npm is unreachable).`);
  } else {
    await run("npx", ["-y", `axbridge-mcp@${newest}`, "--version"], { timeoutMs: 180_000 });
    lines.push(
      `axbridge ${newest} is available, this server runs ${VERSION}. npx now has ${newest} cached.`,
      "1. Restart the axbridge MCP server so the new version runs (Claude Code: /mcp, then reconnect axbridge; Codex and Cursor: restart the session). If a config pins a version, raise it.",
      `2. Raise the AXBridge Swift package to ${newest} (tag v${newest}) and rebuild the app; app and server should run the same version.`,
      `Release notes: https://github.com/jx-grxf/axbridge/releases/tag/v${newest}`,
    );
  }
  if (project) {
    const pins = await findPins(project);
    lines.push("", pins.length ? `Version pins in ${project}:\n${pins.join("\n")}` : `No axbridge version pins found in ${project}.`);
  }
  return text(lines.join("\n"));
});

const transport = new StdioServerTransport();
await server.connect(transport);
