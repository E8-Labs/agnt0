import pc from "picocolors";

export const sym = {
  ok: pc.green("✓"),
  fail: pc.red("✗"),
  warn: pc.yellow("!"),
  dot: pc.dim("·"),
};

export function meterBar(used: number, allowance: number, width = 20): string {
  const ratio = allowance > 0 ? Math.min(1, Math.max(0, used / allowance)) : 0;
  const filled = Math.round(ratio * width);
  const color = ratio >= 1 ? pc.red : ratio >= 0.8 ? pc.yellow : pc.green;
  return color("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
}

export function percent(used: number, allowance: number): string {
  if (allowance <= 0) return "0%";
  return `${Math.round((used / allowance) * 100)}%`;
}

/** "in 2h 13m" / "3m ago". */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = t - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let s: string;
  if (mins < 1) s = "<1m";
  else if (mins < 60) s = `${mins}m`;
  else if (mins < 60 * 48) s = `${Math.floor(mins / 60)}h ${mins % 60}m`;
  else s = `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Strip ANSI codes for width calculations. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

export function table(rows: string[][], gap = 2): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(c))));
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : padEnd(c, (widths[i] ?? 0) + gap))).join("").trimEnd())
    .join("\n");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function label(s: string): string {
  return pc.dim(s);
}
