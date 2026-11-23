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

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

/** Clamp a point-space crop rectangle against actual pixel dimensions so `sips` never overflows near screen edges. */
export function clampCrop(
  crop: CropRect,
  imgWidth: number,
  imgHeight: number,
  pad = 8,
): { px: number; py: number; width: number; height: number } {
  const maxW = Math.max(1, imgWidth);
  const maxH = Math.max(1, imgHeight);
  const num = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  const x = num(crop.x, 0), y = num(crop.y, 0), w = Math.max(0, num(crop.w, 0)), h = Math.max(0, num(crop.h, 0));
  const scale = num(crop.scale, 1) > 0 ? num(crop.scale, 1) : 1;
  const px = Math.min(maxW - 1, Math.max(0, Math.round((x - pad) * scale)));
  const py = Math.min(maxH - 1, Math.max(0, Math.round((y - pad) * scale)));
  const right = Math.min(maxW, Math.max(px + 1, Math.round((x + w + pad) * scale)));
  const bottom = Math.min(maxH, Math.max(py + 1, Math.round((y + h + pad) * scale)));
  return {
    px,
    py,
    width: Math.max(1, right - px),
    height: Math.max(1, bottom - py),
  };
}

export function readPngDimensions(buf: Buffer): { width: number; height: number } {
  // Fast path: PNG IHDR chunk starts at byte 12 ("IHDR"), width at 16..20, height at 20..24.
  if (buf.length >= 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  const parsed = PNG.sync.read(buf);
  return { width: parsed.width, height: parsed.height };
}

function stamp(): string {
  const time = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${time}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function screenshot(
  udid: string,
  opts: { name?: string; width: number; crop?: CropRect },
): Promise<Shot> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stem = (opts.name ?? stamp()).replace(/[^\w.-]+/g, "-");
  const full = join(OUTPUT_DIR, `${stem}.png`);
  await simctl(["io", udid, "screenshot", "--type=png", full]);
  let source = full;
  if (opts.crop) {
    const dims = readPngDimensions(await readFile(full));
    const clamped = clampCrop(opts.crop, dims.width, dims.height, 8);
    source = join(OUTPUT_DIR, `${stem}.crop.png`);
    await run("sips", [
      "--cropOffset", String(clamped.py), String(clamped.px),
      "-c", String(clamped.height), String(clamped.width),
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
