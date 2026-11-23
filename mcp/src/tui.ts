import { randomBytes } from "node:crypto";
import {
  classifyError,
  countScreenElements,
  formatAnalyticsReport,
  readAnalyticsEvents,
  recordEvent,
  summarizeAnalytics,
  type AnalyticsSummary,
} from "./analytics.js";
import { call, listSessions, sessionFor, type Session } from "./bridge.js";
import { ensureBooted, listDevices, openDeviceViewer, type Device } from "./devices.js";
import { collectDoctorReport, formatDoctorLines, type DoctorReport } from "./doctor.js";
import { simctl } from "./exec.js";
import {
  createStyler,
  dotBadge,
  errBadge,
  highlightScreenLine,
  okBadge,
  padEndVisible,
  parseScreen,
  truncateVisible,
  type ScreenElement,
} from "./ui.js";
import { VERSION } from "./version.js";

type TabId = 1 | 2 | 3 | 4;

/** Splits one stdin chunk into keys: escape sequences stay whole, so fast repeats and pastes work. */
export function tokenizeKeys(chunk: string): string[] {
  return chunk.match(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|[\s\S]/gu) ?? [];
}

/** Printable text from a key token; control characters and escape sequences give "". */
export function printableKey(key: string): string {
  return key.startsWith("\x1b") ? "" : key.replace(/[\x00-\x1f\x7f]/g, "");
}

interface PromptState {
  mode: "filter" | "type" | "action" | "go";
  label: string;
  value: string;
  target?: string;
}

interface TuiState {
  tab: TabId;
  activeDevice: Device | null;
  devices: Device[];
  sessions: Session[];
  screenText: string;
  screenLines: string[];
  elements: ScreenElement[];
  selectedIdx: number;
  screenScroll: number;
  filterQuery: string;
  deviceCursor: number;
  deviceScroll: number;
  analyticsDays: 7 | 30 | undefined;
  analyticsSummary: AnalyticsSummary | null;
  analyticsScroll: number;
  doctorReport: DoctorReport | null;
  prompt: PromptState | null;
  statusMsg: string;
  statusOk: boolean;
  lastLatencyMs: number | null;
  busy: boolean;
}

export async function runTui(initialDeviceQuery?: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("axbridge tui requires an interactive TTY terminal.");
    return 1;
  }

  const sessionId = randomBytes(8).toString("hex");
  const s = createStyler(true);

  const state: TuiState = {
    tab: 1,
    activeDevice: null,
    devices: [],
    sessions: [],
    screenText: "",
    screenLines: [],
    elements: [],
    selectedIdx: 0,
    screenScroll: 0,
    filterQuery: "",
    deviceCursor: 0,
    deviceScroll: 0,
    analyticsDays: 7,
    analyticsSummary: null,
    analyticsScroll: 0,
    doctorReport: null,
    prompt: null,
    statusMsg: "Ready",
    statusOk: true,
    lastLatencyMs: null,
    busy: false,
  };

  let exited = false;
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const cols = () => process.stdout.columns || 100;
  const rows = () => process.stdout.rows || 30;

  function setStatus(msg: string, ok = true, latencyMs: number | null = null) {
    state.statusMsg = msg;
    state.statusOk = ok;
    state.lastLatencyMs = latencyMs;
  }

  function filteredElements(): ScreenElement[] {
    if (!state.filterQuery.trim()) return state.elements;
    const q = state.filterQuery.toLowerCase();
    return state.elements.filter(
      (el) =>
        el.label.toLowerCase().includes(q) ||
        (el.value?.toLowerCase().includes(q) ?? false) ||
        (el.id?.toLowerCase().includes(q) ?? false) ||
        el.kind.toLowerCase().includes(q) ||
        `#${el.index}`.includes(q),
    );
  }

  function clampScreenCursor(bodyRows: number) {
    const list = filteredElements();
    if (list.length === 0) {
      state.selectedIdx = 0;
      state.screenScroll = 0;
      return;
    }
    state.selectedIdx = Math.max(0, Math.min(list.length - 1, state.selectedIdx));
    if (state.selectedIdx < state.screenScroll) state.screenScroll = state.selectedIdx;
    if (state.selectedIdx >= state.screenScroll + bodyRows) {
      state.screenScroll = Math.max(0, state.selectedIdx - bodyRows + 1);
    }
  }

  function sortedDevices(): Device[] {
    const activeUdids = new Set(state.sessions.map((sess) => sess.udid));
    return [...state.devices]
      .filter((d) => d.available)
      .sort((a, b) => {
        const sessDiff = Number(activeUdids.has(b.udid)) - Number(activeUdids.has(a.udid));
        if (sessDiff !== 0) return sessDiff;
        const bootDiff = Number(b.state === "Booted") - Number(a.state === "Booted");
        if (bootDiff !== 0) return bootDiff;
        return a.name.localeCompare(b.name);
      });
  }

  function render() {
    if (exited) return;
    const width = cols();
    const height = rows();
    if (width < 50 || height < 12) {
      process.stdout.write("\x1b[H\x1b[2J" + truncateVisible("Terminal too small (need 50x12). q: quit", width));
      return;
    }
    const bodyHeight = height - 5;

    const activeSess = state.activeDevice
      ? state.sessions.find((sess) => sess.udid === state.activeDevice?.udid)
      : undefined;
    const devicePill = state.activeDevice
      ? `${dotBadge(state.activeDevice.state === "Booted", true)} ${state.activeDevice.name}${activeSess ? s.cyan(` (${activeSess.bundleId})`) : ""}`
      : s.yellow("no device selected");

    const headerLeft = `${s.bold(s.cyan("axbridge"))} ${s.dim(`v${VERSION}`)}  ${devicePill}`;
    const tabs = ([
      [1, "Screen"],
      [2, "Devices"],
      [3, "Analytics"],
      [4, "Doctor"],
    ] as const)
      .map(([id, label]) =>
        state.tab === id ? s.inverse(` ${id} ${label} `) : s.dim(` ${id} ${label} `),
      )
      .join(" ");

    const lines: string[] = [];
    lines.push(truncateVisible(`${headerLeft}   ${tabs}`, width));
    lines.push(s.gray("─".repeat(width)));

    const bodyLines: string[] = [];

    if (state.tab === 1) {
      const visible = filteredElements();
      clampScreenCursor(bodyHeight - (state.filterQuery ? 1 : 0));
      if (state.filterQuery) {
        bodyLines.push(s.yellow(`Filter: "${state.filterQuery}" (${visible.length}/${state.elements.length} matching)  [c: clear]`));
      }
      if (!state.activeDevice) {
        bodyLines.push(s.dim("No booted or active simulator found. Switch to Tab 2 (Devices) to select or boot one."));
      } else if (visible.length === 0) {
        if (state.filterQuery && state.elements.length > 0) {
          bodyLines.push(s.dim("No element matches the filter. c: clear it."));
        } else if (state.screenText) {
          for (const rawLine of state.screenLines.slice(0, bodyHeight)) {
            bodyLines.push(highlightScreenLine(rawLine, { color: true }));
          }
        } else {
          bodyLines.push(s.dim("Press `r` to fetch the current screen, or launch your app via axbridge first."));
        }
      } else {
        const listBudget = bodyHeight - (state.filterQuery ? 1 : 0);
        const slice = visible.slice(state.screenScroll, state.screenScroll + listBudget);
        slice.forEach((el, offset) => {
          const isSelected = state.screenScroll + offset === state.selectedIdx;
          const prefix = isSelected ? s.cyan("▸ ") : "  ";
          bodyLines.push(truncateVisible(prefix + highlightScreenLine(el.raw, { color: true, selected: isSelected }), width));
        });
      }
    } else if (state.tab === 2) {
      const list = sortedDevices();
      const activeUdids = new Map(state.sessions.map((sess) => [sess.udid, sess]));
      state.deviceCursor = Math.max(0, Math.min(Math.max(0, list.length - 1), state.deviceCursor));
      if (state.deviceCursor < state.deviceScroll) state.deviceScroll = state.deviceCursor;
      if (state.deviceCursor >= state.deviceScroll + bodyHeight) {
        state.deviceScroll = Math.max(0, state.deviceCursor - bodyHeight + 1);
      }
      const slice = list.slice(state.deviceScroll, state.deviceScroll + bodyHeight);
      for (let i = 0; i < slice.length; i++) {
        const d = slice[i];
        const idx = state.deviceScroll + i;
        const selected = idx === state.deviceCursor;
        const isActiveTarget = state.activeDevice?.udid === d.udid;
        const sess = activeUdids.get(d.udid);
        const prefix = selected ? s.cyan("▸ ") : "  ";
        const badge = dotBadge(d.state === "Booted", true);
        const targetTag = isActiveTarget ? s.cyan(" [active]") : "";
        const sessTag = sess ? s.green(` [bridge: ${sess.bundleId}]`) : "";
        const row = `${prefix}${badge} ${padEndVisible(s.bold(d.name), 24)} ${padEndVisible(s.dim(d.runtime), 12)} ${padEndVisible(d.state === "Booted" ? s.green(d.state) : s.gray(d.state), 10)}${targetTag}${sessTag}`;
        bodyLines.push(truncateVisible(row, width));
      }
      if (list.length === 0) bodyLines.push(s.dim("No available simulators found."));
    } else if (state.tab === 3) {
      const reportLines = state.analyticsSummary
        ? formatAnalyticsReport(state.analyticsSummary, { color: true, width: width - 2 }).split("\n")
        : [s.dim("Loading analytics...")];
      const maxScroll = Math.max(0, reportLines.length - bodyHeight);
      state.analyticsScroll = Math.max(0, Math.min(maxScroll, state.analyticsScroll));
      for (const l of reportLines.slice(state.analyticsScroll, state.analyticsScroll + bodyHeight)) {
        bodyLines.push(truncateVisible(l, width));
      }
    } else if (state.tab === 4) {
      if (!state.doctorReport) {
        bodyLines.push(s.dim("Running diagnostics..."));
      } else {
        for (const line of formatDoctorLines(state.doctorReport.checks, { color: true, width: width - 4 })) {
          bodyLines.push(truncateVisible(`  ${line}`, width));
        }
      }
    }

    while (bodyLines.length < bodyHeight) bodyLines.push("");
    lines.push(...bodyLines.slice(0, bodyHeight));
    lines.push(s.gray("─".repeat(width)));

    if (state.prompt) {
      // Show the tail of long input so the cursor stays visible.
      const room = Math.max(8, width - state.prompt.label.length - 6);
      const shown = [...state.prompt.value].slice(-room).join("");
      lines.push(truncateVisible(`${s.yellow(s.bold(state.prompt.label))}: ${shown}${s.cyan("█")}`, width));
      lines.push(truncateVisible(s.dim("Enter: confirm   Esc: cancel   Backspace: delete"), width));
    } else {
      const helpByTab: Record<TabId, string> = {
        1: "↑/↓/j/k: select  Enter: tap  /: filter  t: type  a: action  +/-: adjust  u/d: scroll  b: back  g: go  r: refresh  q: quit",
        2: "↑/↓/j/k: select  Enter: use device  B: boot  S: shutdown  O: open viewer  D/L: dark/light  9: 9:41 bar  r: refresh  q: quit",
        3: "↑/↓/j/k: scroll  f: window (7d/30d/all)  r: refresh  1-4/Tab: switch tab  q: quit",
        4: "r: re-check  1-4/Tab: switch tab  q: quit",
      };
      const statusIcon = state.busy ? s.yellow("…") : state.statusOk ? okBadge(true) : errBadge(true);
      const latency = state.lastLatencyMs !== null ? s.dim(` (${state.lastLatencyMs}ms)`) : "";
      lines.push(truncateVisible(`${statusIcon} ${state.statusMsg}${latency}`, width));
      lines.push(truncateVisible(s.dim(helpByTab[state.tab]), width));
    }

    // Overwrite in place and clear each line's tail: no flicker from a full-screen clear.
    process.stdout.write("\x1b[H" + lines.map((line) => truncateVisible(line, width) + "\x1b[K").join("\n") + "\x1b[J");
  }

  async function trackTui(
    tool: string,
    fn: () => Promise<string | void>,
    meta: { target?: string; device?: string } = {},
  ) {
    const start = Date.now();
    state.busy = true;
    render();
    try {
      const output = await fn();
      const durationMs = Date.now() - start;
      const outText = typeof output === "string" ? output : "";
      await recordEvent({
        ts: new Date().toISOString(),
        sessionId,
        source: "tui",
        tool,
        durationMs,
        ok: true,
        device: meta.device ?? state.activeDevice?.name,
        target: meta.target,
        elementCount: outText ? countScreenElements(outText) : undefined,
        outputChars: outText ? outText.length : undefined,
      });
      state.lastLatencyMs = durationMs;
    } catch (error) {
      const durationMs = Date.now() - start;
      const message = (error as Error).message || String(error);
      setStatus(message, false, durationMs);
      await recordEvent({
        ts: new Date().toISOString(),
        sessionId,
        source: "tui",
        tool,
        durationMs,
        ok: false,
        errorKind: classifyError(message),
        error: message,
        device: meta.device ?? state.activeDevice?.name,
        target: meta.target,
      });
    } finally {
      state.busy = false;
      render();
    }
  }

  function applyScreenText(rawText: string) {
    state.screenText = rawText;
    state.screenLines = rawText.split("\n");
    state.elements = parseScreen(rawText);
    state.selectedIdx = Math.min(state.selectedIdx, Math.max(0, state.elements.length - 1));
  }

  async function refreshDevices() {
    state.devices = await listDevices();
    state.sessions = await listSessions();
    if (!state.activeDevice) {
      if (initialDeviceQuery) {
        const q = initialDeviceQuery.toLowerCase();
        state.activeDevice =
          state.devices.find((d) => d.udid.toLowerCase() === q || d.name.toLowerCase().includes(q)) ?? null;
      }
      if (!state.activeDevice) {
        const booted = state.devices.filter((d) => d.state === "Booted");
        const sessUdids = new Set(state.sessions.map((sess) => sess.udid));
        state.activeDevice =
          booted.find((d) => sessUdids.has(d.udid)) ??
          booted[0] ??
          sortedDevices()[0] ??
          null;
      }
    } else {
      const updated = state.devices.find((d) => d.udid === state.activeDevice?.udid);
      if (updated) state.activeDevice = updated;
    }
  }

  async function refreshScreen() {
    if (!state.activeDevice) {
      setStatus("No active device selected", false);
      return;
    }
    const dev = state.activeDevice;
    await trackTui("screen", async () => {
      const sess = await sessionFor(dev.udid);
      const t0 = Date.now();
      const reply = await call(sess, "GET", "/screen");
      const ms = Date.now() - t0;
      if (reply.status >= 400) throw new Error(reply.text);
      applyScreenText(reply.text);
      setStatus(`Screen refreshed (${state.elements.length} elements)`, true, ms);
      return reply.text;
    });
  }

  async function refreshAnalytics() {
    const events = await readAnalyticsEvents({ days: state.analyticsDays });
    state.analyticsSummary = summarizeAnalytics(events, { days: state.analyticsDays });
    setStatus(`Analytics loaded (${events.length} events)`, true);
    render();
  }

  async function refreshDoctor() {
    state.doctorReport = await collectDoctorReport({ checkUpdates: false });
    setStatus(`Doctor: ${state.doctorReport.failures} issue(s)`, state.doctorReport.failures === 0);
    render();
  }

  async function bridgeAction(
    toolName: string,
    method: "POST",
    path: string,
    body: string,
    opts: { target?: string; headers?: Record<string, string>; label?: string } = {},
  ) {
    if (!state.activeDevice) {
      setStatus("No active device selected", false);
      render();
      return;
    }
    const dev = state.activeDevice;
    await trackTui(
      toolName,
      async () => {
        const sess = await sessionFor(dev.udid);
        const t0 = Date.now();
        const reply = await call(sess, method, path, body, 15_000, opts.headers);
        const ms = Date.now() - t0;
        if (reply.status === 202) {
          setStatus(`Cannot activate (202): ${reply.text}`, false, ms);
          throw new Error(reply.text);
        }
        if (reply.status >= 400) throw new Error(reply.text);
        applyScreenText(reply.text);
        setStatus(opts.label ?? `${toolName} ok`, true, ms);
        return reply.text;
      },
      { target: opts.target },
    );
  }

  async function switchTab(tab: TabId) {
    state.tab = tab;
    render();
    if (tab === 1 && state.elements.length === 0 && state.activeDevice) await refreshScreen().catch(() => undefined);
    if (tab === 2) {
      await refreshDevices().catch((e) => setStatus((e as Error).message, false));
      render();
    }
    if (tab === 3) await refreshAnalytics();
    if (tab === 4) await refreshDoctor();
  }

  async function submitPrompt(p: PromptState) {
    const value = p.value;
    state.prompt = null;
    if (p.mode === "filter") {
      state.filterQuery = value;
      state.selectedIdx = 0;
      setStatus(value ? `Filtered by "${value}"` : "Filter cleared", true);
      render();
      return;
    }
    if (!value.trim()) {
      render();
      return;
    }
    if (p.mode === "type") {
      await bridgeAction("type", "POST", "/type", value, {
        headers: { "X-AXBridge-Submit": "1" },
        label: "Typed text + submit",
      });
    } else if (p.mode === "action" && p.target) {
      await bridgeAction("action", "POST", "/action", JSON.stringify({ target: p.target, action: value.trim() }), {
        target: p.target,
        headers: { "Content-Type": "application/json" },
        label: `Action "${value.trim()}" on ${p.target}`,
      });
    } else if (p.mode === "go") {
      await bridgeAction("go", "POST", "/go", value.trim(), {
        target: value.trim(),
        label: `Opened ${value.trim()}`,
      });
    }
  }

  async function handleKey(key: string) {

    if (state.prompt) {
      if (key === "\x1b") {
        state.prompt = null;
        setStatus("Cancelled", true);
        render();
        return;
      }
      if (key === "\r" || key === "\n") {
        await submitPrompt(state.prompt);
        return;
      }
      if (key === "\x7f" || key === "\b") {
        state.prompt.value = state.prompt.value.slice(0, -1);
        render();
        return;
      }
      const text = printableKey(key);
      if (text) {
        state.prompt.value += text;
        render();
      }
      return;
    }

    if (key === "q") {
      cleanup(0);
      return;
    }
    if (key === "1" || key === "2" || key === "3" || key === "4") {
      await switchTab(Number(key) as TabId);
      return;
    }
    if (key === "\t") {
      const next = ((state.tab % 4) + 1) as TabId;
      await switchTab(next);
      return;
    }

    if (state.tab === 1) {
      const visible = filteredElements();
      const selected = visible[state.selectedIdx];
      if (key === "\x1b[A" || key === "k") {
        state.selectedIdx = Math.max(0, state.selectedIdx - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        state.selectedIdx = Math.min(Math.max(0, visible.length - 1), state.selectedIdx + 1);
        render();
      } else if (key === "\r" || key === "\n") {
        if (selected) {
          const target = `#${selected.index}`;
          await bridgeAction("tap", "POST", "/tap", target, { target, label: `Tapped #${selected.index} ${selected.label}` });
        }
      } else if (key === "/") {
        state.prompt = { mode: "filter", label: "Filter elements", value: state.filterQuery };
        render();
      } else if (key === "c") {
        state.filterQuery = "";
        state.selectedIdx = 0;
        setStatus("Filter cleared", true);
        render();
      } else if (key === "t") {
        state.prompt = { mode: "type", label: "Type (Enter submits)", value: "" };
        render();
      } else if (key === "a") {
        if (!selected) {
          setStatus("Select an element first", false);
          render();
          return;
        }
        const actions = selected.actions ?? [];
        if (actions.length === 1) {
          const target = `#${selected.index}`;
          await bridgeAction("action", "POST", "/action", JSON.stringify({ target, action: actions[0] }), {
            target,
            headers: { "Content-Type": "application/json" },
            label: `Action "${actions[0]}" on ${target}`,
          });
        } else {
          state.prompt = {
            mode: "action",
            label: actions.length ? `Action (${actions.join("/")})` : `Action on #${selected.index}`,
            value: actions[0] ?? "",
            target: `#${selected.index}`,
          };
          render();
        }
      } else if (key === "+" || key === "=") {
        if (selected) {
          const target = `#${selected.index}`;
          await bridgeAction("adjust", "POST", "/adjust", JSON.stringify({ target, direction: "increment", steps: 1 }), {
            target,
            headers: { "Content-Type": "application/json" },
            label: `Incremented ${target}`,
          });
        }
      } else if (key === "-" || key === "_") {
        if (selected) {
          const target = `#${selected.index}`;
          await bridgeAction("adjust", "POST", "/adjust", JSON.stringify({ target, direction: "decrement", steps: 1 }), {
            target,
            headers: { "Content-Type": "application/json" },
            label: `Decremented ${target}`,
          });
        }
      } else if (key === "u") {
        await bridgeAction("scroll", "POST", "/scroll", "up", { label: "Scrolled up" });
      } else if (key === "d") {
        await bridgeAction("scroll", "POST", "/scroll", "down", { label: "Scrolled down" });
      } else if (key === "b") {
        await bridgeAction("back", "POST", "/back", "", { label: "Navigated back" });
      } else if (key === "g") {
        state.prompt = { mode: "go", label: "Deep link URL", value: "" };
        render();
      } else if (key === "r") {
        await refreshScreen();
      }
      return;
    }

    if (state.tab === 2) {
      const list = sortedDevices();
      const selected = list[state.deviceCursor];
      if (key === "\x1b[A" || key === "k") {
        state.deviceCursor = Math.max(0, state.deviceCursor - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        state.deviceCursor = Math.min(Math.max(0, list.length - 1), state.deviceCursor + 1);
        render();
      } else if (key === "\r" || key === "\n") {
        if (selected) {
          state.activeDevice = selected;
          state.screenText = "";
          state.elements = [];
          setStatus(`Selected ${selected.name}`, true);
          await switchTab(1);
        }
      } else if (key === "B" && selected) {
        await trackTui("boot", async () => {
          await ensureBooted(selected);
          await refreshDevices();
          setStatus(`Booted ${selected.name}`, true);
        }, { device: selected.name });
      } else if (key === "S" && selected) {
        await trackTui("shutdown", async () => {
          await simctl(["shutdown", selected.udid]);
          await refreshDevices();
          setStatus(`Shut down ${selected.name}`, true);
        }, { device: selected.name });
      } else if (key === "O" && selected) {
        await trackTui("open_viewer", async () => {
          const viewer = await openDeviceViewer(selected.udid);
          setStatus(`Opened ${viewer.name}`, true);
        }, { device: selected.name });
      } else if ((key === "D" || key === "L") && selected) {
        const mode = key === "D" ? "dark" : "light";
        await trackTui("set_appearance", async () => {
          await simctl(["ui", selected.udid, "appearance", mode]);
          setStatus(`${selected.name}: ${mode} mode`, true);
        }, { device: selected.name });
      } else if (key === "9" && selected) {
        await trackTui("status_bar", async () => {
          await simctl([
            "status_bar", selected.udid, "override",
            "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100",
            "--cellularMode", "active", "--cellularBars", "4", "--wifiBars", "3", "--dataNetwork", "wifi",
          ]);
          setStatus(`${selected.name}: 9:41 status bar set`, true);
        }, { device: selected.name });
      } else if (key === "r") {
        await refreshDevices();
        setStatus(`Found ${state.devices.filter((d) => d.available).length} devices`, true);
        render();
      }
      return;
    }

    if (state.tab === 3) {
      if (key === "f") {
        state.analyticsDays = state.analyticsDays === 7 ? 30 : state.analyticsDays === 30 ? undefined : 7;
        state.analyticsScroll = 0;
        await refreshAnalytics();
      } else if (key === "r") {
        await refreshAnalytics();
      } else if (key === "\x1b[A" || key === "k") {
        state.analyticsScroll = Math.max(0, state.analyticsScroll - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        state.analyticsScroll++;
        render();
      }
      return;
    }

    if (state.tab === 4 && key === "r") {
      await refreshDoctor();
    }
  }

  let inputQueue = Promise.resolve();
  const onData = (chunk: Buffer) => {
    const keys = tokenizeKeys(chunk.toString("utf8"));
    if (keys.includes("\x03")) {
      cleanup(0);
      return;
    }
    inputQueue = inputQueue
      .then(async () => {
        for (const key of keys) await handleKey(key);
      })
      .catch((e) => {
        state.busy = false;
        setStatus((e as Error).message, false);
        render();
      });
  };
  const onResize = () => render();
  const onSignal = () => cleanup(0);
  const restoreTerminal = () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // stdin already closed
      }
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  // Never leave the terminal in the alternate screen with a hidden cursor and raw input.
  const onCrash = (error: unknown) => {
    if (!exited) {
      exited = true;
      restoreTerminal();
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  };

  function cleanup(code: number) {
    if (exited) return;
    exited = true;
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
    process.off("SIGHUP", onSignal);
    process.stdin.off("data", onData);
    process.stdin.off("end", onSignal);
    process.stdout.off("resize", onResize);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    restoreTerminal();
    process.stdin.pause();
    resolveExit(code);
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  process.stdin.on("end", onSignal);
  process.stdout.on("resize", onResize);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  try {
    await refreshDevices().catch((e) => setStatus((e as Error).message, false));
    render();
    if (state.activeDevice) {
      await refreshScreen().catch(() => undefined);
    }
    return await exitPromise;
  } finally {
    cleanup(0);
  }
}
