import { execFile, spawn, type ChildProcess } from "node:child_process";

export class CommandError extends Error {}

export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd },
      (error, stdout, stderr) => {
        if (error) {
          const output = `${stdout ?? ""}\n${stderr ?? ""}`;
          // xcodebuild buries the cause under hundreds of lines; the error: lines are what matters.
          const errors = [...new Set(output.split("\n").map((l) => l.trim()).filter((l) => /^\/.*: error: /.test(l)))];
          const detail = errors.length
            ? errors.slice(0, 10).join("\n")
            : (stderr || stdout || error.message).toString().trim().split("\n").slice(-12).join("\n");
          reject(new CommandError(`${cmd} ${args.slice(0, 3).join(" ")}: ${detail}`));
        } else {
          resolve(stdout.toString().trim());
        }
      },
    );
  });
}

export function simctl(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  return run("xcrun", ["simctl", ...args], opts);
}

export function background(cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, { stdio: "ignore" });
  // A missing binary must not crash the server with an unhandled 'error' event.
  child.on("error", () => undefined);
  return child;
}

/** Waits for stdout and stderr to drain, so `process.exit` cannot cut off piped output. */
export async function flushStdio(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))),
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
