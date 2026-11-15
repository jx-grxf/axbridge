import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommandError } from "./exec.js";

export interface Session {
  udid: string;
  bundleId: string;
  port: number;
  token: string;
}

const STATE_DIR = join(homedir(), ".cache", "axbridge");
const STATE_FILE = join(STATE_DIR, "sessions.json");
const sessions = new Map<string, Session>();
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8")) as Session[];
    for (const s of saved) sessions.set(s.udid, s);
  } catch {
    // first run
  }
}

async function persist(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify([...sessions.values()], null, 2));
  await chmod(STATE_FILE, 0o600);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function newSession(udid: string, bundleId: string): Promise<Session> {
  await load();
  const session = { udid, bundleId, port: await freePort(), token: randomBytes(24).toString("hex") };
  sessions.set(udid, session);
  await persist();
  return session;
}

export async function sessionFor(udid: string): Promise<Session> {
  await load();
  const session = sessions.get(udid);
  if (!session) throw new CommandError("The app was not launched through axbridge on this simulator. Call `launch` first.");
  return session;
}

export interface BridgeReply {
  status: number;
  text: string;
}

export async function call(session: Session, method: "GET" | "POST", path: string, body = "", timeoutMs = 15_000): Promise<BridgeReply> {
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}${path}`, {
      method,
      body: method === "POST" ? body : undefined,
      headers: { "X-AXBridge-Token": session.token, "Content-Type": "text/plain; charset=utf-8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw new CommandError(
      `The bridge in the app does not answer (${(error as Error).message}). Is it a Debug build with AXBridge.start(), and was it launched with \`launch\`?`,
    );
  }
}
