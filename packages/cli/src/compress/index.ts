/**
 * Shrinking what an agent reads, without hiding what it needs.
 *
 * The server says per step which kinds of tool output may be shrunk (`step.compression.read`); this
 * module does the shrinking, locally, with no dependency and nothing leaving the machine. Three rules
 * decide everything here:
 *
 *  1. **Never lose a signal.** Errors, warnings, failures and summaries are kept whole. What goes is
 *     repetition and bulk: the thousandth identical line, the body of a 900-item array.
 *  2. **Always recoverable.** The original is written to disk and the replacement says where, so an
 *     agent that needs the detail can read it. That is the difference between compression and
 *     truncation.
 *  3. **Do nothing when there is nothing to gain.** Short output, or output that does not shrink, is
 *     passed through untouched — a wrapper that costs tokens to say "compressed by 2%" is a loss.
 */

export type CompressKind = "logs" | "json" | "test" | "csv";

/** Below this, compressing costs more in explanation than it saves. */
export const MIN_BYTES = 1500;
/** Keep the replacement under this much of the original, or leave the original alone. */
export const MAX_RATIO = 0.9;

export interface CompressResult {
  text: string;
  /** What it was treated as, or null when nothing was done. */
  kind: CompressKind | null;
  rawBytes: number;
  sentBytes: number;
}

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP =
  /^\s*(?:\[[^\]]+\]\s*)?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*/;
/**
 * What counts as a signal. Deliberately loose: `AssertionError` and `TypeError` carry no word
 * boundary before "Error", and over-keeping a line costs a few tokens where dropping one can cost
 * the agent the bug it was looking for.
 */
const SIGNAL = /(error|warn|fail|exception|traceback|fatal|panic|\brefused\b|\bdenied\b|\bcannot\b|\bunable\b|timed out)/i;
const TEST_MARKER = /^(?:\s*)(?:✓|✔|√|✗|✘|×|ok \d+|not ok \d+|PASS\b|FAIL\b|# (?:pass|fail|tests)\b|\d+ (?:passing|failing|tests? passed|tests? failed))/i;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** What this output looks like, so the right compressor runs. Order matters: JSON before lines. */
export function detect(text: string): CompressKind | null {
  const t = text.trim();
  if (!t) return null;
  if ((t.startsWith("{") || t.startsWith("[")) && safeParse(t) !== undefined) return "json";
  const lines = t.split("\n");
  if (lines.length >= 4 && lines.slice(0, 20).filter((l) => TEST_MARKER.test(l)).length >= 2) return "test";
  if (isCsv(lines)) return "csv";
  return lines.length >= 8 ? "logs" : null;
}

function safeParse(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function isCsv(lines: string[]): boolean {
  const sample = lines.slice(0, 12).filter((l) => l.trim());
  if (sample.length < 4) return false;
  for (const sep of [",", "\t", ";"]) {
    const counts = sample.map((l) => l.split(sep).length - 1);
    if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ json */

const MAX_ARRAY_ITEMS = 3;
const MAX_STRING = 200;
const MAX_DEPTH = 6;

/**
 * Keeps the shape and loses the bulk: every key survives, because the keys are what an agent reads a
 * JSON blob for; long arrays keep their first few items and say how many were dropped.
 */
export function compressJson(text: string): string {
  const parsed = safeParse(text);
  if (parsed === undefined) return text;
  const shrink = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…(+${v.length - MAX_STRING} chars)` : v;
    if (Array.isArray(v)) {
      if (depth >= MAX_DEPTH) return `[${v.length} items]`;
      const head = v.slice(0, MAX_ARRAY_ITEMS).map((x) => shrink(x, depth + 1));
      return v.length > MAX_ARRAY_ITEMS ? [...head, `…(+${v.length - MAX_ARRAY_ITEMS} more items)`] : head;
    }
    if (v && typeof v === "object") {
      if (depth >= MAX_DEPTH) return "{…}";
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, shrink(x, depth + 1)]));
    }
    return v;
  };
  return JSON.stringify(shrink(parsed, 0), null, 1);
}

/* ------------------------------------------------------------------ logs */

const HEAD_LINES = 12;
const TAIL_LINES = 12;

/** Two lines are "the same line again" when only their numbers, timestamps and hex differ. */
function logKey(line: string): string {
  return line
    .replace(TIMESTAMP, "")
    .replace(/0x[0-9a-f]+/gi, "0x…")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb|%)?\b/gi, "#")
    .trim();
}

export function compressLogs(text: string): string {
  const lines = stripAnsi(text).split("\n");
  // Collapse runs of the same line, keeping the first one as written. A line carrying a signal is
  // never collapsed: sixty errors that differ only in an id are sixty things that went wrong, and
  // "× 60" would throw away which ones.
  const runs: { line: string; count: number; signal: boolean }[] = [];
  for (const line of lines) {
    const signal = SIGNAL.test(line);
    const last = runs[runs.length - 1];
    if (!signal && last && !last.signal && logKey(last.line) === logKey(line)) last.count += 1;
    else runs.push({ line, count: 1, signal });
  }
  const rendered = runs.map((r) => ({ ...r, text: r.count > 1 ? `${r.line}   × ${r.count}` : r.line }));

  // Everything that carries a signal stays, wherever it is. The rest keeps its head and tail.
  const keep = new Set<number>();
  rendered.forEach((r, i) => {
    if (r.signal) {
      keep.add(i);
      // One line either side, because a stack trace's first line is often the one above the match.
      if (i > 0) keep.add(i - 1);
      if (i + 1 < rendered.length) keep.add(i + 1);
    }
  });
  for (let i = 0; i < Math.min(HEAD_LINES, rendered.length); i++) keep.add(i);
  for (let i = Math.max(0, rendered.length - TAIL_LINES); i < rendered.length; i++) keep.add(i);

  const out: string[] = [];
  let hidden = 0;
  rendered.forEach((r, i) => {
    if (keep.has(i)) {
      if (hidden) {
        out.push(`… ${hidden} line${hidden === 1 ? "" : "s"} hidden …`);
        hidden = 0;
      }
      out.push(r.text);
    } else {
      hidden += r.count;
    }
  });
  if (hidden) out.push(`… ${hidden} line${hidden === 1 ? "" : "s"} hidden …`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ test */

const TEST_PASS = /^(?:\s*)(?:✓|✔|√|ok \d+|PASS\b)/i;
const TEST_SUMMARY = /\b(\d+ (?:passing|failing|passed|failed|skipped|todo)|tests?\s+\d+|suites?\s+\d+|# (?:pass|fail|tests|duration))\b/i;

/**
 * A passing test proves nothing an agent needs to read; a failing one is the whole point. Keeps every
 * failure with the lines under it, keeps the summary, and counts what it dropped.
 */
export function compressTest(text: string): string {
  const lines = stripAnsi(text).split("\n");
  const out: string[] = [];
  let passes = 0;
  let inFailure = false;
  lines.forEach((line, i) => {
    const isPass = TEST_PASS.test(line);
    const isFail = /^(?:\s*)(?:✗|✘|×|not ok \d+|FAIL\b)/i.test(line) || SIGNAL.test(line);
    const isSummary = TEST_SUMMARY.test(line) || i >= lines.length - 6;
    if (isPass && !isFail) {
      passes += 1;
      inFailure = false;
      return;
    }
    if (isFail) inFailure = true;
    // Indented lines under a failure are its detail: the diff, the stack, the expected and actual.
    if (isFail || isSummary || (inFailure && /^\s+\S/.test(line)) || !line.trim()) {
      if (line.trim() || out.length) out.push(line);
      return;
    }
    inFailure = false;
    out.push(line);
  });
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return passes ? `${body}\n\n(${passes} passing test line${passes === 1 ? "" : "s"} not shown)` : body;
}

/* ------------------------------------------------------------------- csv */

const CSV_ROWS = 8;

export function compressCsv(text: string): string {
  const lines = stripAnsi(text).trim().split("\n");
  if (lines.length <= CSV_ROWS + 1) return text;
  const sep = [",", "\t", ";"].find((s) => (lines[0]!.split(s).length - 1) >= 1) ?? ",";
  const columns = lines[0]!.split(sep).length;
  const kept = lines.slice(0, CSV_ROWS + 1);
  return [...kept, `… ${lines.length - kept.length} more rows (${columns} columns, ${lines.length - 1} data rows in all)`].join("\n");
}

/* ----------------------------------------------------------------- entry */

/**
 * What the agent is told about the shortening. It matters more than it looks: without it a model
 * reading a short, clean replacement cannot tell whether the command printed nothing interesting or
 * whether the interesting part was cut out — and it will go and re-run the command to find out,
 * which costs more than the compression saved. So the note says how much there was, how many lines
 * carried an error or warning (including none, which is itself the answer to "did it fail?"), and
 * where to read the rest.
 */
function note(kind: CompressKind, original: string, body: string, originalPath?: string): string {
  const lines = original.split("\n").length;
  const kept = body.split("\n").length;
  const signals = original.split("\n").filter((l) => SIGNAL.test(l)).length;
  const signalText =
    kind === "json" || kind === "csv"
      ? ""
      : kind === "test"
        ? ", every failure and the summary kept"
        : signals === 0
          ? ", no line mentioning an error, warning or failure"
          : `, every one of the ${signals} line${signals === 1 ? "" : "s"} mentioning an error, warning or failure kept`;
  const where = originalPath ? `. The untouched output is at ${originalPath}` : "";
  return `\n\n[agnt0: ${lines} lines of ${kind} output shown as ${kept}${signalText}${where}]`;
}

export interface CompressOptions {
  /** Kinds the server allows for this step. Anything else is passed through. */
  kinds: CompressKind[];
  /** Where the untouched original can be read, if it was written down. */
  originalPath?: string;
}

/**
 * Compress one tool output. Returns the original text unchanged whenever compressing would not be a
 * clear win, so the caller can treat the result as "what the model should see" either way.
 */
export function compress(text: string, opts: CompressOptions): CompressResult {
  const rawBytes = Buffer.byteLength(text, "utf8");
  const nothing: CompressResult = { text, kind: null, rawBytes, sentBytes: rawBytes };
  if (!opts.kinds.length || rawBytes < MIN_BYTES) return nothing;
  const kind = detect(text);
  if (!kind || !opts.kinds.includes(kind)) return nothing;

  const body =
    kind === "json" ? compressJson(text) : kind === "test" ? compressTest(text) : kind === "csv" ? compressCsv(text) : compressLogs(text);
  const out = body + note(kind, text, body, opts.originalPath);
  const sentBytes = Buffer.byteLength(out, "utf8");
  // No win, no change: a longer "compressed" output would be a straight loss.
  if (sentBytes > rawBytes * MAX_RATIO) return nothing;
  return { text: out, kind, rawBytes, sentBytes };
}

/** Tokens are billed, bytes are measured; four bytes per token is the usual rule of thumb. */
export function tokensFromBytes(bytes: number): number {
  return Math.round(bytes / 4);
}
