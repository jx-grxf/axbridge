import { describe, expect, it } from "vitest";
import { isNewer } from "../src/version.js";

describe("isNewer", () => {
  it("compares numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });
  it("treats equal versions as not newer", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
  });
  it("ranks a release above its pre-release", () => {
    expect(isNewer("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
  });
});
