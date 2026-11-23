const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function supportsColor(force?: boolean): boolean {
  if (force !== undefined) return force;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Terminal cells a code point occupies: 0 for combining marks, 2 for CJK and emoji, else 1. */
function cellWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleLength(s: string): number {
  let width = 0;
  for (const ch of stripAnsi(s)) width += cellWidth(ch.codePointAt(0) ?? 0);
  return width;
}

export function padEndVisible(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export function padStartVisible(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

/** Cuts to `maxWidth` terminal cells with an ellipsis, keeping colour codes intact and closed. */
export function truncateVisible(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLength(s) <= maxWidth) return s;
  if (maxWidth === 1) return "…";
  let visible = 0;
  let out = "";
  let hasAnsi = false;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i + 2);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        hasAnsi = true;
        i = end + 1;
        continue;
      }
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = cellWidth(cp);
    if (visible + w > maxWidth - 1) break;
    out += ch;
    visible += w;
    i += ch.length;
  }
  return out + (hasAnsi ? "\x1b[0m" : "") + "…";
}

/** Word-wraps plain text to `width` cells; words longer than a line are cut. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(8, width);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = visibleLength(word) > max ? truncateVisible(word, max) : word;
    if (!current) current = piece;
    else if (visibleLength(current) + 1 + visibleLength(piece) <= max) current += " " + piece;
    else {
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/** Width to lay output out for: the terminal, or 100 columns when piped (MCP, files). */
export function terminalWidth(): number {
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  return Math.max(40, Math.min(columns || 100, 160));
}

export interface Styler {
  color: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
  gray: (s: string) => string;
  white: (s: string) => string;
  inverse: (s: string) => string;
}

export function createStyler(color = supportsColor()): Styler {
  const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    color,
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    white: wrap("37"),
    gray: wrap("90"),
    inverse: wrap("7"),
  };
}

export function okBadge(color = supportsColor()): string {
  const s = createStyler(color);
  return s.green("✓");
}

export function errBadge(color = supportsColor()): string {
  const s = createStyler(color);
  return s.red("✗");
}

export function warnBadge(color = supportsColor()): string {
  const s = createStyler(color);
  return s.yellow("▲");
}

export function dotBadge(active: boolean, color = supportsColor()): string {
  const s = createStyler(color);
  return active ? s.green("●") : s.gray("○");
}

export function severityBadge(severity: "high" | "medium" | "info", color = supportsColor()): string {
  const s = createStyler(color);
  if (severity === "high") return s.red(s.bold("[HIGH]"));
  if (severity === "medium") return s.yellow(s.bold("[MED] "));
  return s.cyan("[INFO]");
}

export function bar(value: number, max: number, width = 18, color = supportsColor()): string {
  const s = createStyler(color);
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  return s.cyan("█".repeat(filled)) + s.gray("░".repeat(empty));
}

export function box(
  title: string,
  lines: string[],
  opts: { width?: number; maxWidth?: number; color?: boolean } = {},
): string {
  const s = createStyler(opts.color);
  const maxInner = Math.max(20, (opts.maxWidth ?? terminalWidth()) - 4);
  const heading = truncateVisible(title, maxInner - 2);
  const titleLen = visibleLength(heading);
  const natural = Math.max(opts.width ?? 0, titleLen + 2, 24, ...lines.map((l) => visibleLength(l)));
  const innerWidth = Math.min(natural, maxInner);
  const topFill = Math.max(1, innerWidth - titleLen - 1);
  const top = s.gray("╭─ ") + s.bold(heading) + s.gray(" " + "─".repeat(topFill) + "╮");
  const bottom = s.gray("╰" + "─".repeat(innerWidth + 2) + "╯");
  const body = lines.map((line) => s.gray("│ ") + padEndVisible(truncateVisible(line, innerWidth), innerWidth) + s.gray(" │"));
  return [top, ...body, bottom].join("\n");
}

export function table(
  headers: string[],
  rows: string[][],
  opts: { align?: ("left" | "right")[]; color?: boolean; gap?: number } = {},
): string {
  const s = createStyler(opts.color);
  const gap = " ".repeat(opts.gap ?? 2);
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))),
  );
  const fmtRow = (cells: string[], isHeader = false) =>
    cells
      .map((cell, i) => {
        const align = opts.align?.[i] ?? "left";
        const padded = align === "right" ? padStartVisible(cell, widths[i]) : padEndVisible(cell, widths[i]);
        return isHeader ? s.dim(s.bold(padded)) : padded;
      })
      .join(gap);

  const out = [fmtRow(headers, true), s.gray(widths.map((w) => "─".repeat(w)).join(gap))];
  for (const r of rows) out.push(fmtRow(r));
  return out.join("\n");
}

export interface ScreenElement {
  index: number;
  kind: string;
  label: string;
  value?: string;
  id?: string;
  actions?: string[];
  coords?: string;
  raw: string;
}

/** Parse one axbridge accessibility line, e.g. `1 [button] Save = On  id:saveBtn  actions:[Delete, Pin]  @200,400`. */
export function parseScreenLine(line: string): ScreenElement | null {
  const match = line.match(/^(\d+)\s+\[([^\]]+)\]\s*(.*)$/);
  if (!match) return null;

  const index = Number.parseInt(match[1], 10);
  const kind = match[2];
  let rest = match[3];

  let coords: string | undefined;
  const coordsMatch = rest.match(/(?:^|\s+)(@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)\s*$/);
  if (coordsMatch) {
    coords = coordsMatch[1];
    rest = rest.slice(0, coordsMatch.index);
  }

  let actions: string[] | undefined;
  const actionsMatch = rest.match(/(?:^|\s+)actions:\[([^\]]*)\]\s*$/);
  if (actionsMatch) {
    actions = actionsMatch[1]
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    rest = rest.slice(0, actionsMatch.index);
  }

  let id: string | undefined;
  const idMatch = rest.match(/(?:^|\s+)id:(\S+)\s*$/);
  if (idMatch) {
    id = idMatch[1];
    rest = rest.slice(0, idMatch.index);
  }

  let label = rest.trim();
  let value: string | undefined;
  // The listing prints `label = value` unquoted; the first " = " is the separator.
  const eqIdx = label.indexOf(" = ");
  if (eqIdx !== -1) {
    value = label.slice(eqIdx + 3).trim();
    label = label.slice(0, eqIdx).trim();
  }

  return { index, kind, label, value, id, actions, coords, raw: line };
}

export function parseScreen(text: string): ScreenElement[] {
  const out: ScreenElement[] = [];
  for (const line of text.split("\n")) {
    const el = parseScreenLine(line);
    if (el) out.push(el);
  }
  return out;
}

function styleKind(kind: string, s: Styler): string {
  const badge = `[${kind}]`;
  const lower = kind.toLowerCase();
  if (lower.includes("button") || lower.includes("link") || lower.includes("tab")) return s.green(badge);
  if (lower.includes("field") || lower.includes("search") || lower.includes("textview")) return s.yellow(badge);
  if (
    lower.includes("adjustable") ||
    lower.includes("slider") ||
    lower.includes("stepper") ||
    lower.includes("switch") ||
    lower.includes("picker")
  ) {
    return s.magenta(badge);
  }
  if (lower.includes("static") || lower.includes("heading") || lower.includes("header")) return s.dim(badge);
  return s.blue(badge);
}

export function highlightScreenLine(
  line: string,
  opts: { color?: boolean; selected?: boolean } = {},
): string {
  const s = createStyler(opts.color);
  const el = parseScreenLine(line);
  if (!el) {
    if (!line.trim()) return "";
    return opts.selected ? s.inverse(line) : s.dim(line);
  }

  const parts: string[] = [
    s.cyan(s.bold(`#${el.index}`)),
    styleKind(el.kind, s),
  ];
  if (el.label) parts.push(s.bold(el.label));
  if (el.value !== undefined) parts.push(`${s.dim("=")} ${s.cyan(el.value)}`);
  if (el.id) parts.push(s.blue(`id:${el.id}`));
  if (el.actions?.length) parts.push(s.magenta(`actions:[${el.actions.join(", ")}]`));
  if (el.coords) parts.push(s.gray(el.coords));

  const rendered = parts.join(" ");
  return opts.selected ? s.inverse(stripAnsi(rendered)) : rendered;
}

export function highlightScreen(text: string, opts: { color?: boolean } = {}): string {
  return text
    .split("\n")
    .map((line) => highlightScreenLine(line, opts))
    .join("\n");
}
