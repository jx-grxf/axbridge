import { existsSync } from "node:fs";
import { platform } from "node:os";
import { listSessions, type Session } from "./bridge.js";
import { detectViewerApp, getDeveloperDir, listDevices, type Device, type ViewerApp } from "./devices.js";
import { analyticsEnabled, analyticsFilePath, readAnalyticsEvents } from "./analytics.js";
import { run } from "./exec.js";
import { VERSION, newerVersion } from "./version.js";
import { errBadge, okBadge, padEndVisible, createStyler, warnBadge, wrapText } from "./ui.js";

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
}

export interface DoctorReport {
  version: string;
  checks: DoctorCheck[];
  devices: Device[];
  sessions: Session[];
  viewer: ViewerApp;
  failures: number;
}

/** "none", or the apps with sessions saved from earlier launches, e.g. `5 saved: a.b.App ×3, c.d.Other ×2`. */
export function summarizeSessions(sessions: Session[], show = 2): string {
  if (sessions.length === 0) return "none saved (launch an app via axbridge)";
  const byBundle = new Map<string, number>();
  for (const s of sessions) byBundle.set(s.bundleId, (byBundle.get(s.bundleId) ?? 0) + 1);
  const entries = [...byBundle.entries()].map(([bundle, n]) => (n > 1 ? `${bundle} ×${n}` : bundle));
  const shown = entries.slice(0, show).join(", ");
  const more = entries.length > show ? `, +${entries.length - show} more` : "";
  return `${sessions.length} saved: ${shown}${more}`;
}

/** Check rows for the doctor box and the TUI: icon, label column, detail wrapped under itself. */
export function formatDoctorLines(checks: DoctorCheck[], opts: { color: boolean; width: number }): string[] {
  const s = createStyler(opts.color);
  const labelWidth = 12;
  const detailWidth = Math.max(16, opts.width - labelWidth - 3);
  const out: string[] = [];
  for (const c of checks) {
    const icon = c.warn ? warnBadge(opts.color) : c.ok ? okBadge(opts.color) : errBadge(opts.color);
    const rows = wrapText(c.detail, detailWidth);
    out.push(`${icon} ${padEndVisible(s.bold(c.label), labelWidth)} ${rows[0]}`);
    for (const row of rows.slice(1)) out.push(`${" ".repeat(labelWidth + 2)} ${row}`);
  }
  return out;
}

async function has(cmd: string): Promise<boolean> {
  return run("/usr/bin/which", [cmd]).then(() => true, () => false);
}

export async function collectDoctorReport(opts: { checkUpdates?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let failures = 0;

  if (platform() === "darwin") {
    const macVer = await run("sw_vers", ["-productVersion"]).catch(() => "macOS");
    checks.push({ label: "OS", ok: true, detail: `macOS ${macVer}` });
  } else {
    checks.push({ label: "OS", ok: false, detail: "macOS is required (the iOS Simulator only runs there)" });
    failures++;
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    checks.push({ label: "Node.js", ok: true, detail: `v${process.versions.node}` });
  } else {
    checks.push({ label: "Node.js", ok: false, detail: `v${process.versions.node} (20 or newer required)` });
    failures++;
  }

  let devDir: string | undefined;
  try {
    const xcodeVer = (await run("xcodebuild", ["-version"])).split("\n")[0];
    devDir = await getDeveloperDir();
    checks.push({ label: "Xcode", ok: true, detail: devDir ? `${xcodeVer} (${devDir})` : xcodeVer });
  } catch {
    checks.push({
      label: "Xcode",
      ok: false,
      detail: "xcodebuild not found; install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`",
    });
    failures++;
  }

  const viewer = await detectViewerApp();
  const viewerExists = viewer.appPath === "Simulator" || existsSync(viewer.appPath);
  checks.push({
    label: "Viewer",
    ok: viewerExists,
    warn: !viewerExists,
    detail:
      viewer.kind === "device-hub"
        ? `Device Hub (${viewer.appPath})`
        : `Simulator.app (${viewer.appPath})`,
  });

  let devices: Device[] = [];
  try {
    devices = await listDevices();
    const available = devices.filter((d) => d.available);
    const booted = devices.filter((d) => d.state === "Booted");
    checks.push({
      label: "Simulators",
      ok: true,
      detail: `${available.length} available, ${booted.length} booted${booted.length ? ` (${booted.map((d) => d.name).join(", ")})` : ""}`,
    });
  } catch (error) {
    checks.push({ label: "Simulators", ok: false, detail: `xcrun simctl failed: ${(error as Error).message}` });
    failures++;
  }

  const sessions = await listSessions();
  checks.push({
    label: "Sessions",
    ok: true,
    detail: summarizeSessions(sessions),
  });

  if (await has("sips")) {
    checks.push({ label: "sips", ok: true, detail: "available (screenshots & diffing)" });
  } else {
    checks.push({ label: "sips", ok: false, detail: "sips missing; screenshots will fail" });
    failures++;
  }

  const events = await readAnalyticsEvents();
  checks.push({
    label: "Analytics",
    ok: true,
    detail: analyticsEnabled()
      ? `${events.length} event${events.length === 1 ? "" : "s"} at ${analyticsFilePath()}`
      : `disabled (AXBRIDGE_NO_ANALYTICS=1)`,
  });

  if (opts.checkUpdates !== false) {
    const latest = await newerVersion(3000);
    if (latest) {
      checks.push({
        label: "Version",
        ok: true,
        warn: true,
        detail: `${VERSION} installed; ${latest} available (\`npx -y axbridge-mcp@latest\`)`,
      });
    } else {
      checks.push({ label: "Version", ok: true, detail: `${VERSION} (up to date or offline)` });
    }
  }

  return { version: VERSION, checks, devices, sessions, viewer, failures };
}
