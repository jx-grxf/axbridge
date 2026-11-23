import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.2.0";
const CACHE = join(homedir(), ".cache", "axbridge", "update.json");
const DAY = 24 * 60 * 60 * 1000;

/** Semver-ish comparison of x.y.z; pre-release tags count as older than the release. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const a = parse(candidate), b = parse(current);
  for (let i = 0; i < 3; i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

/**
 * The newest published version, or null when offline, disabled or not newer. Checks npm at
 * most once a day and never waits longer than `timeoutMs`. With `cacheOnly` it never touches
 * the network.
 */
export async function newerVersion(timeoutMs = 1500, opts: { cacheOnly?: boolean } = {}): Promise<string | null> {
  if (process.env.AXBRIDGE_NO_UPDATE_CHECK) return null;
  let latest: string | undefined;
  try {
    const cached = JSON.parse(await readFile(CACHE, "utf8")) as { checkedAt: number; latest: string };
    // The MCP server starts from the cache only, however old; a background check refreshes it.
    if (opts.cacheOnly || Date.now() - cached.checkedAt < DAY) latest = cached.latest;
  } catch {
    // no cache yet
  }
  if (!latest && !opts.cacheOnly) {
    try {
      const response = await fetch("https://registry.npmjs.org/axbridge-mcp/latest", { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      latest = ((await response.json()) as { version: string }).version;
      await mkdir(join(homedir(), ".cache", "axbridge"), { recursive: true });
      await writeFile(CACHE, JSON.stringify({ checkedAt: Date.now(), latest }));
    } catch {
      return null;
    }
  }
  return latest && isNewer(latest, VERSION) ? latest : null;
}

export function updateHint(latest: string): string {
  return `axbridge ${latest} is available (running ${VERSION}). Call the \`update\` tool, or tell the user.`;
}
