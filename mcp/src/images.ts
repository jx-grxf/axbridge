import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { run, simctl } from "./exec.js";

export const OUTPUT_DIR = process.env.AXBRIDGE_OUTPUT_DIR ?? join(tmpdir(), "axbridge");

export interface Shot {
  full: string;
  small: string;
  data: string;
}

function stamp(): string {
  const time = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${time}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function screenshot(
  udid: string,
  opts: { name?: string; width: number; crop?: { x: number; y: number; w: number; h: number; scale: number } },
): Promise<Shot> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stem = (opts.name ?? stamp()).replace(/[^\w.-]+/g, "-");
  const full = join(OUTPUT_DIR, `${stem}.png`);
  await simctl(["io", udid, "screenshot", "--type=png", full]);
  let source = full;
  if (opts.crop) {
    const { x, y, w, h, scale } = opts.crop;
    const pad = 8;
    const px = Math.max(0, Math.round((x - pad) * scale));
    const py = Math.max(0, Math.round((y - pad) * scale));
    source = join(OUTPUT_DIR, `${stem}.crop.png`);
    await run("sips", [
      "--cropOffset", String(py), String(px),
      "-c", String(Math.round((h + 2 * pad) * scale)), String(Math.round((w + 2 * pad) * scale)),
      full, "--out", source,
    ]);
  }
  const small = join(OUTPUT_DIR, `${stem}.small.jpg`);
  await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "--resampleWidth", String(opts.width), source, "--out", small]);
  return { full, small, data: (await readFile(small)).toString("base64") };
}

export interface Comparison {
  diffPixels: number;
  diffPercent: number;
  diffImage: string;
}

/** Compares two PNG files; the actual image is scaled to the reference size first. */
export async function compare(actualPath: string, referencePath: string, threshold = 0.1): Promise<Comparison> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const reference = PNG.sync.read(await readFile(referencePath));
  let actual = PNG.sync.read(await readFile(actualPath));
  if (actual.width !== reference.width || actual.height !== reference.height) {
    const scaled = join(OUTPUT_DIR, `scaled-${stamp()}.png`);
    await run("sips", ["-z", String(reference.height), String(reference.width), actualPath, "--out", scaled]);
    actual = PNG.sync.read(await readFile(scaled));
  }
  const { width, height } = reference;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(reference.data, actual.data, diff.data, width, height, { threshold });
  const diffImage = join(OUTPUT_DIR, `diff-${stamp()}.png`);
  await writeFile(diffImage, PNG.sync.write(diff));
  return { diffPixels, diffPercent: Math.round((diffPixels / (width * height)) * 10_000) / 100, diffImage };
}
