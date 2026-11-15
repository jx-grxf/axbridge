import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./exec.js";
import { listDevices, resolveDevice } from "./devices.js";
import { sessionFor, call } from "./bridge.js";
import { VERSION, newerVersion } from "./version.js";

const HELP = `axbridge ${VERSION}: drive iOS Simulator apps as text from coding agents

Usage
  npx axbridge-mcp                 start the MCP server (stdio); this is what agents run
  npx axbridge-mcp setup <agent>   register the MCP server: claude, codex, cursor or all
                                   (cursor: add --project for .cursor/mcp.json in this folder)
  npx axbridge-mcp doctor          check Xcode, simulators, Node and the installed version
  npx axbridge-mcp screen [device] print the current screen of an app launched by axbridge
  npx axbridge-mcp --version

Docs: https://github.com/jx-grxf/axbridge`;

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const SERVER = { command: "npx", args: ["-y", "axbridge-mcp"] };

async function has(cmd: string): Promise<boolean> {
  return run("/usr/bin/which", [cmd]).then(() => true, () => false);
}

async function doctor(): Promise<number> {
  let failures = 0;
  console.log(`axbridge ${VERSION}`);
  if (platform() === "darwin") ok("macOS"); else { bad("macOS is required (the iOS Simulator only runs there)"); failures++; }
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`); else { bad(`Node.js ${process.versions.node}; 20 or newer is required`); failures++; }
  try {
    ok((await run("xcodebuild", ["-version"])).split("\n")[0]);
  } catch {
    bad("xcodebuild not found; install Xcode and run `sudo xcode-select -s /Applications/Xcode.app`");
    failures++;
  }
  try {
    const devices = await listDevices();
    const booted = devices.filter((d) => d.state === "Booted");
    ok(`simctl: ${devices.filter((d) => d.available).length} simulators, ${booted.length} booted${booted.length ? ` (${booted.map((d) => d.name).join(", ")})` : ""}`);
  } catch (error) {
    bad(`xcrun simctl failed: ${(error as Error).message}`);
    failures++;
  }
  if (await has("sips")) ok("sips (screenshots)"); else { bad("sips missing; screenshots will fail"); failures++; }
  const latest = await newerVersion(3000);
  if (latest) bad(`axbridge ${latest} is available; npx picks it up with \`npx -y axbridge-mcp@latest\``);
  else ok("up to date (or offline)");
  return failures ? 1 : 0;
}

async function setupClaude(): Promise<void> {
  if (!(await has("claude"))) {
    bad("claude CLI not found; run: claude mcp add axbridge --scope user -- npx -y axbridge-mcp");
    return;
  }
  await run("claude", ["mcp", "remove", "axbridge", "--scope", "user"]).catch(() => undefined);
  await run("claude", ["mcp", "add", "axbridge", "--scope", "user", "--", ...[SERVER.command, ...SERVER.args]]);
  ok("Claude Code: added for your user (all projects)");
}

async function setupCodex(): Promise<void> {
  const file = join(homedir(), ".codex", "config.toml");
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (/^\[mcp_servers\.axbridge\]/m.test(current)) {
    ok(`Codex: already in ${file}`);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const block = `\n[mcp_servers.axbridge]\ncommand = "npx"\nargs = ["-y", "axbridge-mcp"]\n`;
  await writeFile(file, current.replace(/\n*$/, "\n") + block);
  ok(`Codex: added to ${file}`);
}

async function setupCursor(project: boolean): Promise<void> {
  const file = project ? join(process.cwd(), ".cursor", "mcp.json") : join(homedir(), ".cursor", "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {
      bad(`Cursor: ${file} is not valid JSON, left unchanged`);
      return;
    }
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), axbridge: SERVER };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  ok(`Cursor: written to ${file}`);
}

async function setup(agent: string | undefined, flags: string[]): Promise<number> {
  const targets = agent === "all" ? ["claude", "codex", "cursor"] : agent ? [agent] : [];
  if (targets.length === 0 || targets.some((t) => !["claude", "codex", "cursor"].includes(t))) {
    console.log("Usage: npx axbridge-mcp setup claude|codex|cursor|all [--project]");
    return 1;
  }
  for (const t of targets) {
    if (t === "claude") await setupClaude();
    if (t === "codex") await setupCodex();
    if (t === "cursor") await setupCursor(flags.includes("--project"));
  }
  console.log("\nNext: add the AXBridge Swift package to your app and call AXBridge.start(). See the README.");
  return 0;
}

async function screen(device: string | undefined): Promise<number> {
  const d = await resolveDevice(device);
  const reply = await call(await sessionFor(d.udid), "GET", "/screen");
  console.log(reply.text);
  return reply.status === 200 ? 0 : 1;
}

export async function runCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "--version":
      case "-v":
      case "version":
        console.log(VERSION);
        return 0;
      case "doctor":
        return await doctor();
      case "setup":
        return await setup(rest.find((a) => !a.startsWith("-")), rest);
      case "screen":
        return await screen(rest[0]);
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      default:
        console.log(HELP);
        return 1;
    }
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
