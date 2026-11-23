import { describe, expect, it } from "vitest";
import { resolveViewerApp } from "../src/devices.js";
import { clampCrop } from "../src/images.js";
import { highlightScreen, parseScreenLine, stripAnsi } from "../src/ui.js";
import { formatAnalyticsReport, summarizeAnalytics } from "../src/analytics.js";

describe("ui screen parser & highlighter", () => {
  it("parses standard lines and lines with actions:[...]", () => {
    const line = '3 [cell] "Inbox" = "3 unread"  id:inboxRow  actions:[Delete, Pin]  @195,240';
    const parsed = parseScreenLine(line);
    expect(parsed).toEqual({
      index: 3,
      kind: "cell",
      label: '"Inbox"',
      value: '"3 unread"',
      id: "inboxRow",
      actions: ["Delete", "Pin"],
      coords: "@195,240",
      raw: line,
    });
  });

  it("parses lines without optional fields and ignores headers", () => {
    expect(parseScreenLine("(empty)")).toBeNull();
    expect(parseScreenLine('1 [button] "Continue"  @200,500')).toEqual({
      index: 1,
      kind: "button",
      label: '"Continue"',
      value: undefined,
      id: undefined,
      actions: undefined,
      coords: "@200,500",
      raw: '1 [button] "Continue"  @200,500',
    });
  });

  it("highlights screen lines cleanly with and without ANSI colors", () => {
    const screen = '1 [button] "Save"  id:saveBtn  actions:[Delete, Pin]  @200,400';
    const plain = highlightScreen(screen, { color: false });
    expect(plain).toBe('#1 [button] "Save" id:saveBtn actions:[Delete, Pin] @200,400');

    const colored = highlightScreen(screen, { color: true });
    expect(colored).toMatch(/\x1b\[/);
    expect(stripAnsi(colored)).toBe(plain);
  });

  it("respects NO_COLOR in analytics report formatting", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const summary = summarizeAnalytics([]);
      const output = formatAnalyticsReport(summary);
      expect(output).not.toMatch(/\x1b\[/);
      expect(output).toContain("╭─ axbridge analytics");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("resolveViewerApp (Device Hub vs Simulator.app)", () => {
  it("prefers DeviceHub.app on Xcode 27+", () => {
    const viewer = resolveViewerApp(
      "/Applications/Xcode.app/Contents/Developer",
      (p) => p === "/Applications/Xcode.app/Contents/Applications/DeviceHub.app",
    );
    expect(viewer).toEqual({
      kind: "device-hub",
      name: "Device Hub",
      appPath: "/Applications/Xcode.app/Contents/Applications/DeviceHub.app",
    });
  });

  it("resolves DeviceHub.app relative to custom xcode-select developer dir", () => {
    const viewer = resolveViewerApp(
      "/Applications/Xcode-27.app/Contents/Developer",
      (p) => p === "/Applications/Xcode-27.app/Contents/Applications/DeviceHub.app",
    );
    expect(viewer).toEqual({
      kind: "device-hub",
      name: "Device Hub",
      appPath: "/Applications/Xcode-27.app/Contents/Applications/DeviceHub.app",
    });
  });

  it("falls back to Simulator.app on older Xcode", () => {
    const viewer = resolveViewerApp(
      "/Applications/Xcode-26.app/Contents/Developer",
      (p) => p === "/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app",
    );
    expect(viewer).toEqual({
      kind: "simulator",
      name: "Simulator",
      appPath: "/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app",
    });
  });

  it("falls back to named Simulator when neither app path exists", () => {
    const viewer = resolveViewerApp("/nonexistent/Developer", () => false);
    expect(viewer).toEqual({ kind: "simulator", name: "Simulator", appPath: "Simulator" });
  });
});

describe("clampCrop", () => {
  it("clamps crops near or beyond screen edges to image bounds", () => {
    expect(clampCrop({ x: -5, y: 2, w: 40, h: 30, scale: 3 }, 1170, 2532, 8)).toEqual({
      px: 0,
      py: 0,
      width: 129,
      height: 120,
    });

    expect(clampCrop({ x: 370, y: 830, w: 40, h: 30, scale: 3 }, 1170, 2532, 8)).toEqual({
      px: 1086,
      py: 2466,
      width: 84,
      height: 66,
    });
  });

  it("preserves exact padded dimensions when inside bounds", () => {
    expect(clampCrop({ x: 50, y: 100, w: 100, h: 40, scale: 2 }, 800, 1600, 8)).toEqual({
      px: 84,
      py: 184,
      width: 232,
      height: 112,
    });
  });
});
