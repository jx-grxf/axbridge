import { describe, expect, it } from "vitest";
import { pickDevice, type Device } from "../src/devices.js";

const d = (name: string, state: string, runtime = "iOS 27.2", udid?: string): Device => ({
  name, state, runtime, available: true,
  udid: udid ?? `${name.length.toString(16).padStart(8, "0")}-0000-0000-0000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`.toUpperCase(),
});

describe("pickDevice", () => {
  it("uses the only booted simulator by default", () => {
    const booted = d("iPhone 17", "Booted");
    expect(pickDevice([d("iPhone 13 mini", "Shutdown"), booted], undefined)).toBe(booted);
  });

  it("asks for a name when several are booted", () => {
    expect(() => pickDevice([d("A", "Booted"), d("B", "Booted")], "booted")).toThrow(/2 simulators are booted/);
  });

  it("explains when nothing is booted", () => {
    expect(() => pickDevice([d("A", "Shutdown")], undefined)).toThrow(/No simulator is booted/);
  });

  it("matches a UDID case-insensitively", () => {
    const target = d("X", "Shutdown", "iOS 27.2", "82781F72-D902-4534-9676-386561853C04");
    expect(pickDevice([d("Y", "Booted"), target], "82781f72-d902-4534-9676-386561853c04")).toBe(target);
  });

  it("prefers an exact name, then a booted one, then the newest runtime", () => {
    const old = d("iPhone 17", "Shutdown", "iOS 26.4");
    const newer = d("iPhone 17", "Shutdown", "iOS 27.2");
    const pro = d("iPhone 17 Pro", "Booted");
    expect(pickDevice([old, newer, pro], "iPhone 17")).toBe(newer);
    const bootedOld = { ...old, state: "Booted" };
    expect(pickDevice([bootedOld, newer], "iPhone 17")).toBe(bootedOld);
  });

  it("falls back to a partial name", () => {
    const mini = d("Test 13 mini", "Shutdown");
    expect(pickDevice([d("iPhone 17", "Booted"), mini], "13 mini")).toBe(mini);
  });

  it("names the problem for an unknown device", () => {
    expect(() => pickDevice([d("iPhone 17", "Booted")], "Pixel")).toThrow(/No simulator named "Pixel"/);
  });
});
