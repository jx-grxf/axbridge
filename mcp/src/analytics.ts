import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bar, box, createStyler, severityBadge, supportsColor, table, terminalWidth, truncateVisible, wrapText } from "./ui.js";

export type AnalyticsErrorKind =
  | "not_found"
  | "cannot_activate"
  | "no_input"
  | "timeout"
  | "bridge_unreachable"
  | "build_error"
  | "other";

export interface AnalyticsEvent {
  ts: string;
  sessionId: string;
  source: "mcp" | "cli" | "tui";
  tool: string;
  durationMs: number;
  ok: boolean;
  errorKind?: AnalyticsErrorKind;
  error?: string; // truncated to 160 chars
  device?: string;
  bundleId?: string;
  target?: string; // truncated to 80 chars, never typed text
  elementCount?: number;
  outputChars?: number;
}

export interface ToolStats {
  tool: string;
  count: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  p95Ms: number;
  avgChars: number;
}

export interface FailingTarget {
  target: string;
  count: number;
  errorKinds: string[];
}

export interface AnalyticsInsight {
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  suggestion: string;
}

export interface AnalyticsSummary {
  days: number | null;
  totalCalls: number;
  sessions: number;
  errorCount: number;
  successRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  avgOutputChars: number;
  estimatedTokensSaved: number;
  tools: ToolStats[];
  errorsByKind: Record<string, number>;
  topFailingTargets: FailingTarget[];
  insights: AnalyticsInsight[];
}

export function analyticsFilePath(): string {
  return process.env.AXBRIDGE_ANALYTICS_FILE || join(homedir(), ".cache", "axbridge", "analytics.jsonl");
}

export function analyticsEnabled(): boolean {
  return !["1", "true"].includes((process.env.AXBRIDGE_NO_ANALYTICS ?? "").trim().toLowerCase());
}

export function classifyError(message: string): AnalyticsErrorKind {
  const m = message || "";
  if (/cannot activate|202|coordinate tap/i.test(m)) return "cannot_activate";
  if (/not found|no element|\b404\b|no match|couldn't find|unable to find/i.test(m)) return "not_found";
  if (/no focused|no input|focus a field|first responder|no active text/i.test(m)) return "no_input";
  if (/timed out|timeout|within \d+\s*s|\b408\b/i.test(m)) return "timeout";
  if (/bridge.*does not answer|not launched through axbridge|ECONNREFUSED|fetch failed|connection refused/i.test(m)) {
    return "bridge_unreachable";
  }
  if (/xcodebuild|build failed|No \.app in|: error:/i.test(m)) return "build_error";
  return "other";
}

export function countScreenElements(output: string): number | undefined {
  if (!output) return undefined;
  const lines = output.split("\n");
  const count = lines.filter((line) => /^\d+ \[/.test(line)).length;
  if (count > 0) return count;
  if (/^\(empty/m.test(output.trim())) return 0;
  return undefined;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Deep links carry tokens and ids in path and query; keep only scheme and host. */
export function redactTarget(target: string): string {
  const t = target.replace(/\s+/g, " ").trim();
  const match = t.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)(.*)$/i);
  if (!match) return t.slice(0, 80);
  const host = match[2].replace(/^.*@/, "");
  return `${match[1]}${host}${match[3] ? "/…" : ""}`.slice(0, 80);
}

/**
 * Failure messages end up in a local file. Keep the first line only: bridge errors append the
 * whole screen listing after a blank line, and that listing contains field contents.
 */
function sanitizeError(message: string): string {
  const first = message.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.replace(homedir(), "~").replace(/\s+/g, " ").trim().slice(0, 160);
}

function sanitizeEvent(event: AnalyticsEvent): AnalyticsEvent {
  const out: AnalyticsEvent = {
    ts: event.ts,
    sessionId: event.sessionId,
    source: event.source,
    tool: event.tool,
    durationMs: Math.max(0, Math.round(event.durationMs)),
    ok: event.ok,
  };
  if (event.errorKind) out.errorKind = event.errorKind;
  if (event.error) out.error = sanitizeError(event.error);
  if (event.device) out.device = event.device.slice(0, 80);
  if (event.bundleId) out.bundleId = event.bundleId.slice(0, 120);
  if (event.target) out.target = URL_LIKE.test(event.target.trim()) ? redactTarget(event.target) : event.target.replace(/\s+/g, " ").trim().slice(0, 80);
  if (typeof event.elementCount === "number") out.elementCount = event.elementCount;
  if (typeof event.outputChars === "number") out.outputChars = event.outputChars;
  return out;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const compacted = new Set<string>();

/** Keeps the file bounded: once per process, an oversized log is cut to its newest half. */
async function compactIfLarge(filePath: string): Promise<void> {
  if (compacted.has(filePath)) return;
  compacted.add(filePath);
  try {
    if ((await stat(filePath)).size <= MAX_FILE_BYTES) return;
    const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
    await writeFile(filePath, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // Missing file or a race with another process: nothing to compact.
  }
}

/** Non-blocking local JSONL append; never throws or fails caller commands. */
export async function recordEvent(event: AnalyticsEvent, filePath = analyticsFilePath()): Promise<void> {
  if (!analyticsEnabled()) return;
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await compactIfLarge(filePath);
    await appendFile(filePath, JSON.stringify(sanitizeEvent(event)) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(filePath, 0o600);
  } catch {
    // Analytics must never interrupt user or agent workflows.
  }
}

export async function readAnalyticsEvents(opts: { days?: number; filePath?: string; nowMs?: number } = {}): Promise<AnalyticsEvent[]> {
  const filePath = opts.filePath ?? analyticsFilePath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const cutoff = opts.days && opts.days > 0 ? (opts.nowMs ?? Date.now()) - opts.days * 86_400_000 : null;
  const events: AnalyticsEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AnalyticsEvent;
      if (!parsed || typeof parsed.tool !== "string" || typeof parsed.ts !== "string") continue;
      if (cutoff !== null) {
        const ms = Date.parse(parsed.ts);
        if (Number.isNaN(ms) || ms < cutoff) continue;
      }
      events.push({
        ...parsed,
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "unknown",
        durationMs: Number.isFinite(parsed.durationMs) ? Math.max(0, parsed.durationMs) : 0,
        ok: parsed.ok !== false,
      });
    } catch {
      // Skip malformed line
    }
  }
  return events;
}

export async function resetAnalytics(filePath = analyticsFilePath()): Promise<void> {
  await rm(filePath, { force: true });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

const ACTION_TOOLS_RETURNING_SCREEN = new Set(["tap", "type", "scroll", "back", "go", "action", "adjust", "wait_for", "launch", "build_and_run"]);
const INTERACTION_TOOLS = new Set(["screen", "tap", "type", "scroll", "back", "go", "action", "adjust", "wait_for", "screenshot", "screenshots"]);
const UI_LATENCY_TOOLS = new Set(["screen", "tap", "type", "scroll", "back", "go", "action", "adjust"]);

export function summarizeAnalytics(
  events: AnalyticsEvent[],
  opts: { days?: number; nowMs?: number } = {},
): AnalyticsSummary {
  const days = opts.days && opts.days > 0 ? opts.days : null;
  const cutoff = days ? (opts.nowMs ?? Date.now()) - days * 86_400_000 : null;
  const filtered = cutoff === null
    ? events
    : events.filter((e) => {
        const ms = Date.parse(e.ts);
        return !Number.isNaN(ms) && ms >= cutoff;
      });

  const totalCalls = filtered.length;
  const sessions = new Set(filtered.map((e) => e.sessionId)).size;
  const errorCount = filtered.filter((e) => !e.ok).length;
  const successRate = totalCalls > 0 ? Math.round(((totalCalls - errorCount) / totalCalls) * 1000) / 10 : 100;

  const durations = filtered.map((e) => e.durationMs).sort((a, b) => a - b);
  const avgMs = totalCalls > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / totalCalls) : 0;
  const p50Ms = percentile(durations, 50);
  const p95Ms = percentile(durations, 95);

  const withChars = filtered.filter((e) => typeof e.outputChars === "number");
  const avgOutputChars = withChars.length > 0
    ? Math.round(withChars.reduce((sum, e) => sum + (e.outputChars ?? 0), 0) / withChars.length)
    : 0;

  // Each text screen reading replaces a ~1500-token screenshot with ~outputChars/4 tokens.
  const screenReads = filtered.filter((e) => typeof e.elementCount === "number" && typeof e.outputChars === "number");
  const estimatedTokensSaved = screenReads.reduce(
    (sum, e) => sum + Math.max(0, 1500 - Math.round((e.outputChars ?? 0) / 4)),
    0,
  );

  // Per-tool stats
  const byTool = new Map<string, AnalyticsEvent[]>();
  for (const e of filtered) {
    const arr = byTool.get(e.tool) ?? [];
    arr.push(e);
    byTool.set(e.tool, arr);
  }
  const tools: ToolStats[] = [...byTool.entries()]
    .map(([tool, list]) => {
      const errs = list.filter((e) => !e.ok).length;
      const durs = list.map((e) => e.durationMs).sort((a, b) => a - b);
      const charItems = list.filter((e) => typeof e.outputChars === "number");
      return {
        tool,
        count: list.length,
        errors: errs,
        errorRate: Math.round((errs / list.length) * 1000) / 10,
        avgMs: Math.round(durs.reduce((a, b) => a + b, 0) / list.length),
        p95Ms: percentile(durs, 95),
        avgChars: charItems.length
          ? Math.round(charItems.reduce((a, b) => a + (b.outputChars ?? 0), 0) / charItems.length)
          : 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  // Errors by kind & top failing targets
  const errorsByKind: Record<string, number> = {};
  const targetFailures = new Map<string, { count: number; kinds: Set<string> }>();
  for (const e of filtered) {
    const kind = e.errorKind;
    if (!e.ok || kind) {
      const resolvedKind = kind ?? "other";
      errorsByKind[resolvedKind] = (errorsByKind[resolvedKind] ?? 0) + 1;
      if (e.target) {
        const entry = targetFailures.get(e.target) ?? { count: 0, kinds: new Set<string>() };
        entry.count++;
        entry.kinds.add(resolvedKind);
        targetFailures.set(e.target, entry);
      }
    }
  }
  const topFailingTargets: FailingTarget[] = [...targetFailures.entries()]
    .map(([target, info]) => ({ target, count: info.count, errorKinds: [...info.kinds].sort() }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
    .slice(0, 5);

  const insights = detectInsights(filtered, { tools, errorsByKind, topFailingTargets, estimatedTokensSaved });

  return {
    days,
    totalCalls,
    sessions,
    errorCount,
    successRate,
    avgMs,
    p50Ms,
    p95Ms,
    avgOutputChars,
    estimatedTokensSaved,
    tools,
    errorsByKind,
    topFailingTargets,
    insights,
  };
}

function detectInsights(
  events: AnalyticsEvent[],
  ctx: {
    tools: ToolStats[];
    errorsByKind: Record<string, number>;
    topFailingTargets: FailingTarget[];
    estimatedTokensSaved: number;
  },
): AnalyticsInsight[] {
  if (events.length === 0) {
    return [
      {
        severity: "info",
        title: "No analytics recorded yet",
        detail: "Events are logged locally after MCP tool calls, CLI commands, and TUI actions.",
        suggestion: "Run your app through axbridge or `axbridge screen` and check back here.",
      },
    ];
  }

  const insights: AnalyticsInsight[] = [];

  // 1. cannot_activate (HTTP 202)
  const cannotActivate = ctx.errorsByKind.cannot_activate ?? 0;
  if (cannotActivate > 0) {
    insights.push({
      severity: cannotActivate >= 3 ? "high" : "medium",
      title: `${cannotActivate} non-activatable element hit${cannotActivate === 1 ? "" : "s"} (HTTP 202)`,
      detail: "Elements were matched on screen but had no accessibility activation handler.",
      suggestion: "Add `.accessibilityAddTraits(.isButton)` or implement `accessibilityActivate()` on custom interactive views.",
    });
  }

  // 2. Repeated not_found / high tool failure rate
  const notFound = ctx.errorsByKind.not_found ?? 0;
  if (notFound >= 2 || ctx.topFailingTargets.some((t) => t.count >= 2 && t.errorKinds.includes("not_found"))) {
    const worst = ctx.topFailingTargets.find((t) => t.errorKinds.includes("not_found"));
    insights.push({
      severity: notFound >= 4 ? "high" : "medium",
      title: `${notFound} element lookup failure${notFound === 1 ? "" : "s"} (not_found)`,
      detail: worst
        ? `Top failing target: "${worst.target}" (${worst.count} failures).`
        : "Targets could not be found in the accessibility tree.",
      suggestion: "Add explicit `.accessibilityIdentifier(...)` or stable `.accessibilityLabel(...)` to controls, or scroll/wait before tapping.",
    });
  }

  for (const t of ctx.tools) {
    if (t.count >= 3 && t.errorRate >= 25) {
      insights.push({
        severity: t.errorRate >= 50 ? "high" : "medium",
        title: `High failure rate on \`${t.tool}\` (${t.errorRate}%)`,
        detail: `${t.errors} of ${t.count} calls failed.`,
        suggestion: `Inspect recent errors on \`${t.tool}\` and ensure preconditions (focus, visibility, or bridge readiness) are met.`,
      });
    }
  }

  // 3. Retry loops: same tool + target called 2+ times within 15s with at least one failure
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  let retryLoops = 0;
  const lastByKey = new Map<string, { ts: number; failed: boolean; counted: boolean }>();
  for (const e of sorted) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts)) continue;
    const key = `${e.sessionId}|${e.tool}|${e.target ?? ""}`;
    const prev = lastByKey.get(key);
    if (prev && ts - prev.ts <= 15_000 && (prev.failed || !e.ok)) {
      if (!prev.counted) {
        retryLoops++;
        prev.counted = true;
      }
      prev.ts = ts;
      prev.failed = prev.failed || !e.ok;
    } else {
      lastByKey.set(key, { ts, failed: !e.ok, counted: false });
    }
  }
  if (retryLoops > 0) {
    insights.push({
      severity: retryLoops >= 3 ? "high" : "medium",
      title: `${retryLoops} retry loop${retryLoops === 1 ? "" : "s"} detected`,
      detail: "Same tool/target retried rapidly within 15s after a failure.",
      suggestion: "Use `wait_for` before interacting with async/loading UI instead of polling with repeated taps or reads.",
    });
  }

  // 4. Screenshot overuse (>35% of interaction calls)
  const interactionCalls = events.filter((e) => INTERACTION_TOOLS.has(e.tool));
  const screenshotCalls = events.filter((e) => e.tool === "screenshot" || e.tool === "screenshots").length;
  if (interactionCalls.length >= 4 && screenshotCalls / interactionCalls.length > 0.35) {
    const pct = Math.round((screenshotCalls / interactionCalls.length) * 100);
    insights.push({
      severity: "medium",
      title: `Heavy screenshot usage (${pct}% of UI calls)`,
      detail: `${screenshotCalls} of ${interactionCalls.length} UI interactions used vision screenshots.`,
      suggestion: "Prefer text-based `screen`, `tap`, and `wait_for`; reserve `screenshot` (with `element` crop) for visual verification.",
    });
  }

  // 5. Redundant `screen` calls right after an action that already returned the screen
  let redundantScreens = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (
      curr.tool === "screen" &&
      prev.ok &&
      ACTION_TOOLS_RETURNING_SCREEN.has(prev.tool) &&
      curr.sessionId === prev.sessionId &&
      (curr.device ?? "") === (prev.device ?? "")
    ) {
      const dt = Date.parse(curr.ts) - Date.parse(prev.ts);
      if (!Number.isNaN(dt) && dt >= 0 && dt <= 5_000) redundantScreens++;
    }
  }
  if (redundantScreens >= 2) {
    insights.push({
      severity: "medium",
      title: `${redundantScreens} redundant \`screen\` calls after actions`,
      detail: "`screen` was called immediately after an action that already returned the updated screen.",
      suggestion: "Use the screen returned by `tap`, `type`, `scroll`, `back`, `go`, `action`, or `adjust` directly.",
    });
  }

  // 6. Token bloat
  const elementSamples = events.filter((e) => typeof e.elementCount === "number");
  const avgElements = elementSamples.length
    ? elementSamples.reduce((s, e) => s + (e.elementCount ?? 0), 0) / elementSamples.length
    : 0;
  const charSamples = events.filter((e) => typeof e.elementCount === "number" && typeof e.outputChars === "number");
  const avgScreenChars = charSamples.length
    ? charSamples.reduce((s, e) => s + (e.outputChars ?? 0), 0) / charSamples.length
    : 0;
  if (avgElements > 50 || avgScreenChars > 3500) {
    insights.push({
      severity: "medium",
      title: `Noisy accessibility tree (${Math.round(avgElements)} elements / ${Math.round(avgScreenChars)} chars avg)`,
      detail: "Large accessibility trees inflate token usage and slow down agent parsing.",
      suggestion: "Combine labels with `.accessibilityElement(children: .combine)` or hide decorative views with `.accessibilityHidden(true)`.",
    });
  }

  // 7. no_input errors
  const noInput = ctx.errorsByKind.no_input ?? 0;
  if (noInput > 0) {
    insights.push({
      severity: "medium",
      title: `${noInput} typing error${noInput === 1 ? "" : "s"} without focused field (no_input)`,
      detail: "`type` was invoked when no text input held focus.",
      suggestion: "Tap the text field (or `wait_for` it) before calling `type`.",
    });
  }

  // 8. bridge_unreachable errors
  const unreachable = ctx.errorsByKind.bridge_unreachable ?? 0;
  if (unreachable > 0) {
    insights.push({
      severity: "high",
      title: `${unreachable} unreachable bridge error${unreachable === 1 ? "" : "s"}`,
      detail: "The in-app HTTP bridge did not respond (app crashed, backgrounded, or non-Debug build).",
      suggestion: "Verify `AXBridge.start()` runs in Debug builds and inspect `logs` for crashes.",
    });
  }

  // 9. Slow tools
  const slowUi = ctx.tools.filter((t) => UI_LATENCY_TOOLS.has(t.tool) && t.count >= 3 && t.p95Ms > 2000);
  if (slowUi.length > 0) {
    insights.push({
      severity: "medium",
      title: `Slow UI responses (${slowUi.map((t) => `${t.tool} p95=${t.p95Ms}ms`).join(", ")})`,
      detail: "Interaction latency exceeded 2000ms at p95.",
      suggestion: "Check for heavy main-thread work or long animations; consider speeding up animations in Debug builds.",
    });
  }
  const slowBuild = ctx.tools.find((t) => t.tool === "build_and_run" && t.avgMs > 60_000);
  if (slowBuild) {
    insights.push({
      severity: "info",
      title: `\`build_and_run\` averages ${Math.round(slowBuild.avgMs / 1000)}s`,
      detail: "Repeated full Xcode builds add significant waiting time.",
      suggestion: "Use `launch` directly when Swift source has not changed.",
    });
  }

  if (insights.length === 0) {
    insights.push({
      severity: "info",
      title: "Workflow looks healthy",
      detail: `No reliability or efficiency anti-patterns found across ${events.length} calls.`,
      suggestion: `Keep using text interactions — estimated ~${ctx.estimatedTokensSaved.toLocaleString("en-US")} tokens saved vs screenshots.`,
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  return insights.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function formatAnalyticsReport(
  summary: AnalyticsSummary,
  opts: { color?: boolean; width?: number } = {},
): string {
  const color = supportsColor(opts.color);
  const width = Math.max(40, opts.width ?? terminalWidth());
  const s = createStyler(color);
  const windowLabel = summary.days ? `last ${summary.days}d` : "all time";
  const lines: string[] = [];

  lines.push(
    box(
      `axbridge analytics (${windowLabel})`,
      [
        `${s.bold("Calls:")} ${summary.totalCalls}  ${s.dim("|")}  ${s.bold("Sessions:")} ${summary.sessions}  ${s.dim("|")}  ${s.bold("Success:")} ${summary.successRate >= 95 ? s.green(`${summary.successRate}%`) : summary.successRate >= 80 ? s.yellow(`${summary.successRate}%`) : s.red(`${summary.successRate}%`)} (${summary.errorCount} err)`,
        `${s.bold("Latency:")} p50 ${summary.p50Ms}ms  p95 ${summary.p95Ms}ms  avg ${summary.avgMs}ms`,
        `${s.bold("Output:")} avg ${summary.avgOutputChars} chars  ${s.dim("|")}  ${s.bold("Est. tokens saved:")} ${s.cyan(summary.estimatedTokensSaved.toLocaleString("en-US"))}`,
      ],
      { color, maxWidth: width },
    ),
  );

  if (summary.tools.length > 0) {
    lines.push("");
    lines.push(s.bold("Tool Usage & Latency"));
    const maxCalls = Math.max(...summary.tools.map((t) => t.count), 1);
    const rows = summary.tools.map((t) => [
      t.tool,
      bar(t.count, maxCalls, 14, color),
      String(t.count),
      t.errors ? s.red(`${t.errorRate}%`) : s.green("0%"),
      `${t.avgMs}ms`,
      `${t.p95Ms}ms`,
      t.avgChars ? String(t.avgChars) : "-",
    ]);
    lines.push(
      table(["Tool", "Volume", "Calls", "Err%", "Avg", "P95", "Chars"], rows, {
        align: ["left", "left", "right", "right", "right", "right", "right"],
        color,
      }),
    );
  }

  const errEntries = Object.entries(summary.errorsByKind).sort((a, b) => b[1] - a[1]);
  if (errEntries.length > 0) {
    lines.push("");
    lines.push(s.bold("Errors by Kind"));
    lines.push(
      "  " +
        errEntries
          .map(([kind, count]) => `${s.red(kind)}: ${count}`)
          .join("   "),
    );
  }

  if (summary.topFailingTargets.length > 0) {
    lines.push("");
    lines.push(s.bold("Top Failing Targets"));
    for (const t of summary.topFailingTargets) {
      const meta = ` (${t.count}x: ${t.errorKinds.join(", ")})`;
      lines.push(`  ${s.red("×")} ${s.bold(truncateVisible(t.target, Math.max(10, width - 6 - meta.length)))}${meta}`);
    }
  }

  lines.push("");
  lines.push(s.bold("What to Improve"));
  for (const insight of summary.insights) {
    lines.push(`  ${severityBadge(insight.severity, color)} ${s.bold(truncateVisible(insight.title, width - 10))}`);
    const textWidth = Math.max(20, width - 11);
    for (const row of wrapText(insight.detail, textWidth)) lines.push(`         ${s.dim(row)}`);
    wrapText(insight.suggestion, textWidth - 2).forEach((row, i) => lines.push(`         ${i === 0 ? s.cyan("→") : " "} ${row}`));
  }

  return lines.join("\n");
}
