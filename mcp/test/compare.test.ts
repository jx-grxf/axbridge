import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { compare } from "../src/images.js";

async function png(dir: string, name: string, paint: (x: number, y: number) => [number, number, number]) {
  const image = new PNG({ width: 10, height: 10 });
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4;
      const [r, g, b] = paint(x, y);
      image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = 255;
    }
  }
  const path = join(dir, name);
  await writeFile(path, PNG.sync.write(image));
  return path;
}

describe("compare", () => {
  it("reports identical images as 0 %", async () => {
    const dir = await mkdtemp(join(tmpdir(), "axbridge-test-"));
    const a = await png(dir, "a.png", () => [20, 40, 60]);
    const b = await png(dir, "b.png", () => [20, 40, 60]);
    expect((await compare(a, b)).diffPercent).toBe(0);
  });

  it("counts changed pixels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "axbridge-test-"));
    const a = await png(dir, "a.png", () => [0, 0, 0]);
    const b = await png(dir, "b.png", (_x, y) => (y === 0 ? [255, 255, 255] : [0, 0, 0]));
    const result = await compare(a, b);
    expect(result.diffPixels).toBe(10);
    expect(result.diffPercent).toBe(10);
  });
});
