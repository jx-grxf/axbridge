import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run, CommandError } from "./exec.js";

export interface BuildResult {
  appPath: string;
  bundleId: string;
}

export async function buildForSimulator(opts: {
  project?: string;
  workspace?: string;
  scheme: string;
  udid: string;
  configuration: string;
}): Promise<BuildResult> {
  if (!opts.project && !opts.workspace) throw new CommandError("Pass project (.xcodeproj) or workspace (.xcworkspace).");
  const container = resolve(opts.workspace ?? opts.project!);
  const key = createHash("sha1").update(`${container}|${opts.scheme}`).digest("hex").slice(0, 12);
  const derived = join(homedir(), ".cache", "axbridge", "DerivedData", key);
  await run(
    "xcodebuild",
    [
      opts.workspace ? "-workspace" : "-project", container,
      "-scheme", opts.scheme,
      "-configuration", opts.configuration,
      "-destination", `id=${opts.udid}`,
      "-derivedDataPath", derived,
      "build",
    ],
    { timeoutMs: 30 * 60_000 },
  );
  const products = join(derived, "Build", "Products", `${opts.configuration}-iphonesimulator`);
  const apps = (await readdir(products)).filter((f) => f.endsWith(".app"));
  if (apps.length === 0) throw new CommandError(`No .app in ${products}`);
  // A scheme can build extensions or test hosts next to the app; the scheme's own app
  // usually carries its name.
  const app = apps.find((a) => a.replace(/\.app$/, "") === opts.scheme) ?? apps[0];
  const appPath = join(products, app);
  return { appPath, bundleId: await bundleIdOf(appPath) };
}

export async function bundleIdOf(appPath: string): Promise<string> {
  return run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(appPath, "Info.plist")]);
}
