import { simctl, CommandError } from "./exec.js";

export interface Device {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  available: boolean;
}

export async function listDevices(): Promise<Device[]> {
  const raw = JSON.parse(await simctl(["list", "devices", "--json"])) as {
    devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable: boolean }>>;
  };
  const out: Device[] = [];
  for (const [runtimeId, list] of Object.entries(raw.devices)) {
    const runtime = runtimeId.replace("com.apple.CoreSimulator.SimRuntime.", "").replace(/-(\d+)-(\d+)$/, " $1.$2");
    for (const d of list) {
      out.push({ udid: d.udid, name: d.name, state: d.state, runtime, available: d.isAvailable });
    }
  }
  return out;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/** Pure resolution so it can be tested: "booted", a UDID, or an exact (then partial) name. */
export function pickDevice(devices: Device[], query: string | undefined): Device {
  const q = (query ?? "booted").trim();
  if (q === "booted") {
    const booted = devices.filter((d) => d.state === "Booted");
    if (booted.length === 1) return booted[0];
    if (booted.length === 0) throw new CommandError("No simulator is booted. Use `boot` with a device name, or `devices` to list them.");
    throw new CommandError(
      `${booted.length} simulators are booted; pass device as one of: ${booted.map((d) => `"${d.name}"`).join(", ")}`,
    );
  }
  if (UDID.test(q)) {
    const hit = devices.find((d) => d.udid.toLowerCase() === q.toLowerCase());
    if (hit) return hit;
    throw new CommandError(`No simulator with UDID ${q}`);
  }
  const available = devices.filter((d) => d.available);
  const exact = available.filter((d) => d.name === q);
  const pool = exact.length ? exact : available.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));
  if (pool.length === 0) throw new CommandError(`No simulator named "${q}". Use \`devices\` to list them.`);
  // Several runtimes can carry the same name; prefer a booted one, then the newest runtime.
  const ranked = [...pool].sort(
    (a, b) => Number(b.state === "Booted") - Number(a.state === "Booted") || b.runtime.localeCompare(a.runtime, undefined, { numeric: true }),
  );
  return ranked[0];
}

export async function resolveDevice(query?: string): Promise<Device> {
  return pickDevice(await listDevices(), query);
}

export async function ensureBooted(device: Device): Promise<void> {
  if (device.state !== "Booted") {
    await simctl(["boot", device.udid]).catch((e: Error) => {
      if (!/current state: Booted/.test(e.message)) throw e;
    });
  }
  await simctl(["bootstatus", device.udid, "-b"], { timeoutMs: 180_000 });
}
