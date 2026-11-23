import { describe, expect, it } from "vitest";
import { numFlag, parseFlags } from "../src/cli.js";
import { formatDoctorLines, summarizeSessions } from "../src/doctor.js";
import { logPredicate, resolveViewerApp } from "../src/devices.js";
import { clampCrop } from "../src/images.js";
import { printableKey, tokenizeKeys } from "../src/tui.js";
import {
  box,
  parseScreen,
  parseScreenLine,
  stripAnsi,
  truncateVisible,
  visibleLength,
  wrapText,
} from "../src/ui.js";
import { isNewer } from "../src/version.js";

describe("parseScreenLine on real Swift output (labels are not quoted)", () => {
  it("parses label, value, id, actions and coordinates", () => {
    expect(parseScreenLine("4 [button] Save = On  id:saveBtn  actions:[Delete, Pin]  @200,400")).toMatchObject({
      index: 4,
      kind: "button",
      label: "Save",
      value: "On",
      id: "saveBtn",
      actions: ["Delete", "Pin"],
      coords: "@200,400",
    });
  });

  it("handles negative coordinates and elements without label", () => {
    expect(parseScreenLine("7 [field]  id:email  @-12,340")).toMatchObject({ label: "", id: "email", coords: "@-12,340" });
    expect(parseScreenLine("8 [text] 3 unread  @10,-5")).toMatchObject({ label: "3 unread", value: undefined });
  });

  it("splits at the first ' = ' only, and keeps '=' inside words and quotes", () => {
    expect(parseScreenLine("1 [text] a=b = c = d  @1,2")).toMatchObject({ label: "a=b", value: "c = d" });
    expect(parseScreenLine('2 [text] 5" screen = big  @1,2')).toMatchObject({ label: '5" screen', value: "big" });
  });

  it("parses a whole listing and skips non-element lines", () => {
    const text = "1 [header] Stations  @195,60\nnot found: x\n\n2 [button] Pin  actions:[Pin]  @300,200";
    expect(parseScreen(text).map((e) => e.index)).toEqual([1, 2]);
  });
});

describe("terminal width handling", () => {
  it("counts emoji and CJK as two cells and ignores colour codes", () => {
    expect(visibleLength("abc")).toBe(3);
    expect(visibleLength("日本")).toBe(4);
    expect(visibleLength("🚇 U1")).toBe(5);
    expect(visibleLength("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("truncates by cells, keeps colours closed and never splits a surrogate pair", () => {
    const out = truncateVisible("\x1b[1mWien 🚇🚇🚇🚇 Praterstern\x1b[0m", 10);
    expect(visibleLength(out)).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("\x1b[0m");
    expect(truncateVisible("short", 10)).toBe("short");
    expect(truncateVisible("日本語日本語", 5)).toBe("日本…");
  });

  it("wraps words and cuts overlong ones", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("x".repeat(40), 10).every((l) => visibleLength(l) <= 10)).toBe(true);
  });

  it("draws a box whose every line has the same width, capped to maxWidth", () => {
    const long = "x".repeat(300);
    const rendered = box("axbridge doctor", ["short", long, "日本語 🚇"], { color: false, maxWidth: 80 });
    const widths = rendered.split("\n").map((l) => visibleLength(l));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(80);
    expect(rendered.split("\n")[0].startsWith("╭─ axbridge doctor")).toBe(true);
  });

  it("keeps small boxes small and aligned", () => {
    const widths = box("t", ["a", "bb"], { color: false, maxWidth: 120 }).split("\n").map((l) => visibleLength(l));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeLessThan(40);
  });
});

describe("doctor output", () => {
  const sessions = Array.from({ length: 9 }, (_, i) => ({
    udid: `UDID-${i}`,
    bundleId: i < 6 ? "dev.axbridge.example" : `com.example.App${i}`,
    port: 50000 + i,
    token: "t",
  }));

  it("summarizes many saved sessions instead of listing every port", () => {
    const text = summarizeSessions(sessions);
    expect(text).toBe("9 saved: dev.axbridge.example ×6, com.example.App6, +2 more");
    expect(text.length).toBeLessThan(80);
    expect(summarizeSessions([])).toContain("none saved");
  });

  it("wraps long details so the doctor box stays within 80 columns", () => {
    const lines = formatDoctorLines(
      [
        { label: "Xcode", ok: true, detail: "Xcode 27.2 (/Applications/Xcode.app/Contents/Developer) with a really long suffix to force wrapping" },
        { label: "Sessions", ok: true, detail: summarizeSessions(sessions) },
        { label: "sips", ok: false, detail: "sips missing" },
      ],
      { color: false, width: 76 },
    );
    const rendered = box("axbridge 0.1.1 doctor", lines, { color: false, maxWidth: 80 }).split("\n");
    expect(rendered.every((l) => visibleLength(l) <= 80)).toBe(true);
    expect(stripAnsi(rendered.join("\n"))).toContain("+2 more");
    expect(stripAnsi(rendered.join("\n"))).not.toContain("…");
  });
});

describe("cli flags", () => {
  it("parses value flags, = syntax, booleans and the -- terminator", () => {
    const { positional, flags } = parseFlags(["Save", "--timeout", "500", "--steps=3", "--clear", "--", "--literal", "-5"]);
    expect(positional).toEqual(["Save", "--literal", "-5"]);
    expect(flags).toEqual({ "--timeout": "500", "--steps": "3", "--clear": true });
  });

  it("rejects non-numeric numbers instead of ignoring them", () => {
    expect(numFlag({ "--days": "7" }, "--days")).toBe(7);
    expect(numFlag({}, "--days")).toBeUndefined();
    expect(() => numFlag({ "--days": "soon" }, "--days")).toThrow(/--days needs a number/);
    expect(() => numFlag({ "--days": true }, "--days")).toThrow(/needs a number/);
  });
});

describe("tui keys", () => {
  it("splits chunks into keys and keeps escape sequences whole", () => {
    expect(tokenizeKeys("\x1b[B\x1b[Bj")).toEqual(["\x1b[B", "\x1b[B", "j"]);
    expect(tokenizeKeys("\x1b")).toEqual(["\x1b"]);
    expect(tokenizeKeys("ö🚇")).toEqual(["ö", "🚇"]);
  });

  it("filters control characters out of typed or pasted text", () => {
    expect(printableKey("a")).toBe("a");
    expect(printableKey("\x1b[A")).toBe("");
    expect(printableKey("\t")).toBe("");
  });
});

describe("devices and images", () => {
  it("prefers the selected Xcode's viewer over another install", () => {
    const viewer = resolveViewerApp(
      "/Applications/Xcode-26.app/Contents/Developer",
      (p) =>
        p === "/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app" ||
        p === "/Applications/Xcode.app/Contents/Applications/DeviceHub.app",
    );
    expect(viewer.kind).toBe("simulator");
    expect(viewer.appPath).toBe("/Applications/Xcode-26.app/Contents/Developer/Applications/Simulator.app");
  });

  it("falls back to the default Xcode's Device Hub when the selected one has no viewer", () => {
    const viewer = resolveViewerApp("/Library/Developer/CommandLineTools", (p) => p === "/Applications/Xcode.app/Contents/Applications/DeviceHub.app");
    expect(viewer.kind).toBe("device-hub");
  });

  it("builds log predicates for apps and processes without injectable quotes", () => {
    expect(logPredicate({})).toBeNull();
    expect(logPredicate({ process: 'Evil" OR 1==1 OR process == "x' })).toBe('process == "Evil OR 1==1 OR process == x"');
    expect(logPredicate({ bundleId: "dev.axbridge.example", executable: "AXBridgeExample" })).toBe(
      'subsystem BEGINSWITH "dev.axbridge.example" OR process == "AXBridgeExample" OR process == "example"',
    );
    expect(logPredicate({ bundleId: "Solo" })).toBe('subsystem BEGINSWITH "Solo" OR process == "Solo"');
  });

  it("clamps crops with missing or non-finite frame data", () => {
    const crop = clampCrop({ x: Number.NaN, y: 10, w: -5, h: Number.POSITIVE_INFINITY, scale: 0 }, 100, 200, 8);
    expect(Object.values(crop).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    expect(crop.width).toBeGreaterThanOrEqual(1);
  });

  it("orders pre-release versions numerically", () => {
    expect(isNewer("0.2.0-beta.10", "0.2.0-beta.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0-beta.9")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.2.0")).toBe(false);
  });
});
