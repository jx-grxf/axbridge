import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { background, run, simctl, CommandError } from "./exec.js";

export interface Device {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  available: boolean;
}

export interface ViewerApp {
  kind: "device-hub" | "simulator";
  name: string;
  appPath: string;
}

const DEFAULT_DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";

/**
 * Pure viewer resolution so it can be unit-tested without filesystem or xcode-select. The selected
 * Xcode wins (Device Hub in Xcode 27+, Simulator.app before), then the default install.
 */
export function resolveViewerApp(
  developerDir: string | undefined,
  exists: (path: string) => boolean = existsSync,
): ViewerApp {
  const selected = developerDir?.trim() || DEFAULT_DEVELOPER_DIR;
  const candidates: ViewerApp[] = [];
  for (const dir of [...new Set([selected, DEFAULT_DEVELOPER_DIR])]) {
    candidates.push(
      { kind: "device-hub", name: "Device Hub", appPath: resolve(dir, "..", "Applications", "DeviceHub.app") },
      { kind: "simulator", name: "Simulator", appPath: resolve(dir, "Applications", "Simulator.app") },
    );
  }
  return candidates.find((c) => exists(c.appPath)) ?? { kind: "simulator", name: "Simulator", appPath: "Simulator" };
}

export async function getDeveloperDir(): Promise<string | undefined> {
  return run("xcode-select", ["-p"]).catch(() => undefined);
}

export async function detectViewerApp(): Promise<ViewerApp> {
  return resolveViewerApp(await getDeveloperDir());
}

export async function openDeviceViewer(udid: string): Promise<ViewerApp> {
  const viewer = await detectViewerApp();
  if (viewer.kind === "device-hub") {
    // DeviceHub.app replaces Simulator.app in Xcode 27+ and does not take -CurrentDeviceUDID.
    background("open", ["-a", viewer.appPath]);
  } else {
    background("open", ["-a", viewer.appPath, "--args", "-CurrentDeviceUDID", udid]);
  }
  return viewer;
}

export async function listDevices(): Promise<Device[]> {
  const raw = JSON.parse(await simctl(["list", "devices", "--json"])) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable: boolean }>>;
  };
  const out: Device[] = [];
  for (const [runtimeId, list] of Object.entries(raw.devices)) {
    const runtime = runtimeId.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-(\d+)-(\d+)$/, " $1.$2");
    for (const d of list) {
      out.push({ udid: d.udid, name: d.name, state: d.state, runtime, available: d.isAvailable });
    }
  }
  return out;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Pure resolution so it can be tested: "booted", a UDID, or an exact (then partial) name. */
export function pickDevice(devices: Device[], query: string | undefined): Device {
  const q = (query ?? "booted").trim();
  if (q === "booted") {
    const booted = devices.filter((d) => d.state === "Booted");
    if (booted.length === 1) return booted[0];
    if (booted.length === 0) throw new CommandError("No simulator is booted. Use `boot` with a device name, or `devices` to list them.");
    throw new CommandError(
      `${booted.length} simulators are booted; pass device as one of: ${booted.map((d) => `"${d.name}"`).join(", ")}`,
    );
  }
  if (UDID.test(q)) {
    const hit = devices.find((d) => d.udid.toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    throw new CommandError(`No simulator with UDID ${q}`);
  }
  const available = devices.filter((d) => d.available);
  const exact = available.filter((d) => d.name === q);
  const pool = exact.length ? exact : available.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  if (pool.length === 0) throw new CommandError(`No simulator named "${q}". Use \`devices\` to list them.`);
  // Several runtimes can carry the same name; prefer a booted one, then the newest runtime.
  const ranked = [...pool].sort(
    (a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || b.runtime.localeCompare(a.runtime, undefined, { numeric: true }),
  );
  return ranked[0];
}

export async function resolveDevice(query?: string): Promise<Device> {
  return pickDevice(await listDevices(), query);
}

export async function ensureBooted(device: Device): Promise<void> {
  if (device.state !== "Booted") {
    await simctl(["boot", device.udid]).catch((e: Error) => {
      if (!/current state: Booted/.test(e.message)) throw e;
    });
  }
  await simctl(["bootstatus", device.udid, "-b"], { timeoutMs: 180_000 });
}

const quoted = (s: string) => s.replace(/["\\\r\n]/g, "");

/** `log show` predicate for an app (subsystem or executable) or a process; null for no filter. */
export function logPredicate(opts: { bundleId?: string; process?: string; executable?: string }): string | null {
  if (opts.process) return `process == "${quoted(opts.process)}"`;
  if (!opts.bundleId) return null;
  const bundle = quoted(opts.bundleId);
  const names = new Set([opts.executable, bundle.split(".").pop()].filter((n): n is string => Boolean(n)).map(quoted));
  return [`subsystem BEGINSWITH "${bundle}"`, ...[...names].map((n) => `process == "${n}"`)].join(" OR ");
}

/** The app's executable name; print and NSLog output carries it as the process, not the bundle id. */
async function executableOf(udid: string, bundleId: string): Promise<string | undefined> {
  try {
    const app = await simctl(["get_app_container", udid, bundleId]);
    return await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", join(app, "Info.plist")]);
  } catch {
    return undefined;
  }
}

export async function readSimulatorLogs(
  udid: string,
  opts: { bundleId?: string; process?: string; seconds?: number; lines?: number } = {},
): Promise<string> {
  const seconds = Math.max(1, Math.min(3600, Math.round(opts.seconds ?? 30)));
  const maxLines = Math.max(1, Math.min(500, Math.round(opts.lines ?? 80)));
  const args = ["spawn", udid, "log", "show", "--last", `${seconds}s`, "--style", "compact", "--info"];
  const executable = !opts.process && opts.bundleId ? await executableOf(udid, opts.bundleId) : undefined;
  const predicate = logPredicate({ ...opts, executable });
  if (predicate) args.push("--predicate", predicate);

  let output: string;
  try {
    output = await simctl(args, { timeoutMs: 60_000 });
  } catch (error) {
    if (/current state|not booted|Shutdown/i.test((error as Error).message)) {
      throw new CommandError("The simulator is not booted, so it has no logs. Boot it with `boot` first.");
    }
    throw error;
  }
  // `log show` prints a filter banner and a column header even when nothing matched.
  const lines = output
    .split("\n")
    .filter((l) => l.length > 0 && !/^(Filtering the log data|Skipping info and debug|Timestamp\s+Ty\s)/.test(l));
  if (lines.length === 0) return "(no matching log entries)";
  return lines.slice(-maxLines).join("\n");
}
