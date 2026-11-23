import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyError,
  countScreenElements,
  formatAnalyticsReport,
  readAnalyticsEvents,
  recordEvent,
  resetAnalytics,
  redactTarget,
  summarizeAnalytics,
  type AnalyticsEvent,
} from "../src/analytics.js";

const BASE_MS = Date.parse("2026-11-23T12:00:00.000Z");

function makeEvent(overrides: Partial<AnalyticsEvent> = {}, offsetMs = 0): AnalyticsEvent {
  return {
    ts: new Date(BASE_MS + offsetMs).toISOString(),
    sessionId: "sess-1",
    source: "mcp",
    tool: "tap",
    durationMs: 120,
    ok: true,
    ...overrides,
  };
}

describe("analytics", () => {
  afterEach(() => {
    delete process.env.AXBRIDGE_NO_ANALYTICS;
    delete process.env.AXBRIDGE_ANALYTICS_FILE;
  });

  it("appends, reads, sets 0600 mode, filters by days, and resets JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "axbridge-analytics-"));
    const file = join(dir, "analytics.jsonl");

    await recordEvent(makeEvent({ tool: "launch", target: "secret-should-stay", outputChars: 300, elementCount: 4 }, -10 * 86_400_000), file);
    await recordEvent(makeEvent({ tool: "tap", target: "Save", outputChars: 240, elementCount: 3 }), file);

    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    // Append a corrupt line to verify resilience
    await writeFile(file, "not-valid-json\n", { flag: "a" });

    const all = await readAnalyticsEvents({ filePath: file, nowMs: BASE_MS });
    expect(all).toHaveLength(2);

    const recent = await readAnalyticsEvents({ days: 7, filePath: file, nowMs: BASE_MS });
    expect(recent).toHaveLength(1);
    expect(recent[0].tool).toBe("tap");

    process.env.AXBRIDGE_NO_ANALYTICS = "1";
    await recordEvent(makeEvent({ tool: "back" }), file);
    expect(await readAnalyticsEvents({ filePath: file, nowMs: BASE_MS })).toHaveLength(2);

    await resetAnalytics(file);
    expect(await readAnalyticsEvents({ filePath: file, nowMs: BASE_MS })).toHaveLength(0);
  });

  it("classifies errors accurately", () => {
    expect(classifyError("Element not found: Save")).toBe("not_found");
    expect(classifyError("HTTP 404: no element matching #9")).toBe("not_found");
    expect(classifyError("Cannot activate element (202). Use a coordinate tap.")).toBe("cannot_activate");
    expect(classifyError("No focused text field")).toBe("no_input");
    expect(classifyError("wait timed out after 10000ms")).toBe("timeout");
    expect(classifyError("The bridge in the app does not answer (fetch failed)")).toBe("bridge_unreachable");
    expect(classifyError("xcodebuild build failed: /Foo.swift:12: error: cannot find")).toBe("build_error");
    expect(classifyError("Something unexpected")).toBe("other");
  });

  it("counts screen elements from accessibility text", () => {
    const screen = [
      '1 [button] "Sign In"  id:loginBtn  @195,400',
      '2 [textfield] "Email" = "a@b.com"  @195,300',
      '3 [cell] "Item"  actions:[Delete, Pin]  @195,200',
    ].join("\n");
    expect(countScreenElements(screen)).toBe(3);
    expect(countScreenElements("(empty screen)")).toBe(0);
    expect(countScreenElements("booted: iPhone 17")).toBeUndefined();
  });

  it("computes p50, p95, rates, and estimated tokens saved", () => {
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const events: AnalyticsEvent[] = durations.map((d, i) =>
      makeEvent({
        sessionId: i < 5 ? "s1" : "s2",
        tool: i % 2 === 0 ? "tap" : "screen",
        durationMs: d,
        ok: i !== 9,
        ...(i === 9 ? { errorKind: "not_found", target: "Missing" } : {}),
        elementCount: 5,
        outputChars: 400,
      }),
    );

    const summary = summarizeAnalytics(events, { nowMs: BASE_MS });
    expect(summary.totalCalls).toBe(10);
    expect(summary.sessions).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(summary.successRate).toBe(90);
    expect(summary.p50Ms).toBe(500);
    expect(summary.p95Ms).toBe(1000);
    // 10 screen reads * (1500 - 400/4) = 14000
    expect(summary.estimatedTokensSaved).toBe(14_000);
    expect(summary.topFailingTargets[0]).toEqual({ target: "Missing", count: 1, errorKinds: ["not_found"] });
  });

  it("detects retry loops, screenshot overuse, 202 cannot_activate, redundant screens, high failure rate, token bloat, and no_input", () => {
    const events: AnalyticsEvent[] = [
      // Retry loop + high failure rate on tap + not_found
      makeEvent({ tool: "tap", target: "Submit", ok: false, errorKind: "not_found", durationMs: 2500 }, 0),
      makeEvent({ tool: "tap", target: "Submit", ok: false, errorKind: "not_found", durationMs: 2600 }, 2_000),
      makeEvent({ tool: "tap", target: "Submit", ok: true, elementCount: 65, outputChars: 4200, durationMs: 200 }, 4_000),
      // Redundant screen right after successful tap
      makeEvent({ tool: "screen", ok: true, elementCount: 65, outputChars: 4200, durationMs: 100 }, 5_000),
      makeEvent({ tool: "tap", target: "Next", ok: true, elementCount: 60, outputChars: 4000, durationMs: 150 }, 8_000),
      makeEvent({ tool: "screen", ok: true, elementCount: 60, outputChars: 4000, durationMs: 100 }, 9_000),
      // cannot_activate (202)
      makeEvent({ tool: "tap", target: "CustomCard", ok: false, errorKind: "cannot_activate" }, 12_000),
      // no_input
      makeEvent({ tool: "type", ok: false, errorKind: "no_input" }, 14_000),
      // bridge_unreachable
      makeEvent({ tool: "back", ok: false, errorKind: "bridge_unreachable" }, 16_000),
      // Screenshot overuse (>35% of interaction calls: 6 screenshots out of 15 interaction calls = 40%)
      makeEvent({ tool: "screenshot", ok: true }, 20_000),
      makeEvent({ tool: "screenshot", ok: true }, 21_000),
      makeEvent({ tool: "screenshot", ok: true }, 22_000),
      makeEvent({ tool: "screenshot", ok: true }, 23_000),
      makeEvent({ tool: "screenshot", ok: true }, 24_000),
      makeEvent({ tool: "screenshot", ok: true }, 25_000),
    ];

    const summary = summarizeAnalytics(events, { nowMs: BASE_MS + 30_000 });
    const titles = summary.insights.map((i) => i.title);

    expect(titles.some((t) => /non-activatable/i.test(t))).toBe(true);
    expect(titles.some((t) => /not_found/i.test(t))).toBe(true);
    expect(titles.some((t) => /High failure rate on `tap`/i.test(t))).toBe(true);
    expect(titles.some((t) => /retry loop/i.test(t))).toBe(true);
    expect(titles.some((t) => /Heavy screenshot usage/i.test(t))).toBe(true);
    expect(titles.some((t) => /redundant `screen` calls/i.test(t))).toBe(true);
    expect(titles.some((t) => /Noisy accessibility tree/i.test(t))).toBe(true);
    expect(titles.some((t) => /no_input/i.test(t))).toBe(true);
    expect(titles.some((t) => /unreachable bridge/i.test(t))).toBe(true);
    expect(titles.some((t) => /Slow UI responses/i.test(t))).toBe(true);

    const plainReport = formatAnalyticsReport(summary, { color: false });
    expect(plainReport).not.toMatch(/\x1b\[/);
    expect(plainReport).toContain("What to Improve");
    expect(plainReport).toContain("█");
  });

  it("never persists deep link queries, screen contents from error bodies, or the home directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "axbridge-privacy-"));
    const file = join(dir, "analytics.jsonl");
    await recordEvent(
      makeEvent({
        tool: "go",
        ok: false,
        errorKind: "not_found",
        target: "myapp://auth/reset?token=SECRET123&email=jo@example.com#frag",
        error: "not found: Save\n\n1 [field] Email = jo@example.com  id:email  @10,20\n2 [field] Password = hunter2",
      }),
      file,
    );
    await recordEvent(makeEvent({ tool: "build_and_run", ok: false, error: `${homedir()}/Projects/App/Foo.swift:1: error: boom` }), file);
    const raw = await readFile(file, "utf8");
    for (const secret of ["SECRET123", "jo@example.com", "hunter2", "email=", homedir()]) expect(raw).not.toContain(secret);
    const [go, build] = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(go.target).toBe("myapp://auth/…");
    expect(go.error).toBe("not found: Save");
    expect(build.error.startsWith("~/Projects/App/Foo.swift")).toBe(true);
  });

  it("redacts URL targets to scheme and host", () => {
    expect(redactTarget("https://user:pw@example.com/path?q=1")).toBe("https://example.com/…");
    expect(redactTarget("myapp://home")).toBe("myapp://home");
    expect(redactTarget("Save button")).toBe("Save button");
  });

  it("honours AXBRIDGE_NO_ANALYTICS=true and tolerates damaged records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "axbridge-damaged-"));
    const file = join(dir, "analytics.jsonl");
    process.env.AXBRIDGE_NO_ANALYTICS = "true";
    await recordEvent(makeEvent(), file);
    expect(await readAnalyticsEvents({ filePath: file })).toHaveLength(0);
    delete process.env.AXBRIDGE_NO_ANALYTICS;

    await writeFile(file, ['{"tool":"tap","ts":"2026-11-23T12:00:00.000Z","durationMs":"fast"}', "null", "[1]", '{"tool":1,"ts":"x"}'].join("\n") + "\n");
    const events = await readAnalyticsEvents({ filePath: file });
    expect(events).toHaveLength(1);
    expect(events[0].durationMs).toBe(0);
    expect(summarizeAnalytics(events).avgMs).toBe(0);
  });

  it("does not report a slow tool from a single sample, and names the right not_found target", () => {
    const slow = summarizeAnalytics([makeEvent({ tool: "tap", durationMs: 9000 })]);
    expect(slow.insights.some((i) => /Slow UI/.test(i.title))).toBe(false);

    const events = [
      makeEvent({ tool: "tap", ok: false, errorKind: "cannot_activate", target: "Card" }, 0),
      makeEvent({ tool: "tap", ok: false, errorKind: "cannot_activate", target: "Card" }, 60_000),
      makeEvent({ tool: "tap", ok: false, errorKind: "cannot_activate", target: "Card" }, 120_000),
      makeEvent({ tool: "tap", ok: false, errorKind: "not_found", target: "Missing" }, 180_000),
      makeEvent({ tool: "tap", ok: false, errorKind: "not_found", target: "Missing" }, 240_000),
    ];
    const insight = summarizeAnalytics(events).insights.find((i) => /not_found/.test(i.title));
    expect(insight?.detail).toContain('"Missing"');
  });
});
