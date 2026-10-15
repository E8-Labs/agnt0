/**
 * The PostToolUse hook process: Claude Code runs it after a tool call, hands it the call and its
 * result on stdin, and uses what it prints to decide what the model sees.
 *
 * It is a separate process invocation (that is the hook contract), so everything it needs comes from
 * argv and nothing is shared with the run: no imports from the API client, no tokens, no prompt. It
 * must also be impossible to break the step — any error at all and it prints nothing, which leaves
 * the tool's own output untouched.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compress, type CompressKind } from "./index.js";

/** Stats one hook invocation appends, for the runner to total up when the step ends. */
export interface CompressStat {
  tool: string;
  kind: CompressKind | null;
  raw: number;
  sent: number;
}

export const STATS_FILE = "stats.jsonl";

interface HookInput {
  tool_name?: string;
  tool_use_id?: string;
  tool_response?: unknown;
}

/** Bash output is the bulk: the logs, the test runs, the JSON a command prints. */
const TOOLS = new Set(["Bash", "BashOutput"]);

/**
 * Decides the replacement for one tool result. Pure, so the decision can be tested without a process:
 * returns null when the output should be left exactly as it is.
 */
export function hookOutput(
  input: HookInput,
  opts: { kinds: CompressKind[]; saveOriginal: (text: string, which: string) => string | undefined },
): { updated: unknown; stats: CompressStat[] } | null {
  const tool = input.tool_name ?? "";
  if (!TOOLS.has(tool)) return null;
  const response = input.tool_response;
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;

  const stats: CompressStat[] = [];
  const next: Record<string, unknown> = { ...r };
  let changed = false;
  for (const field of ["stdout", "stderr"]) {
    const text = r[field];
    if (typeof text !== "string" || !text) continue;
    const originalPath = opts.saveOriginal(text, `${input.tool_use_id ?? "out"}.${field}`);
    const result = compress(text, { kinds: opts.kinds, ...(originalPath ? { originalPath } : {}) });
    stats.push({ tool, kind: result.kind, raw: result.rawBytes, sent: result.sentBytes });
    if (result.kind) {
      next[field] = result.text;
      changed = true;
    }
  }
  return changed || stats.length ? { updated: changed ? next : r, stats } : null;
}

/** Reads the hook call on stdin and prints the replacement. Never throws: a broken hook is a no-op. */
export async function runCompressHook(argv: string[], stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
  try {
    const dir = argValue(argv, "--dir");
    const kinds = (argValue(argv, "--kinds") ?? "").split(",").filter(Boolean) as CompressKind[];
    if (!dir || !kinds.length) return;

    const raw = await readAll(stdin);
    const input = JSON.parse(raw) as HookInput;
    let n = 0;
    const out = hookOutput(input, {
      kinds,
      saveOriginal: (text, which) => {
        try {
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${safeName(which)}.${n++}.txt`);
          writeFileSync(file, text);
          return file;
        } catch {
          // Without somewhere to put the original we must not shorten anything, or detail is lost.
          return undefined;
        }
      },
    });
    if (!out) return;
    try {
      appendFileSync(join(dir, STATS_FILE), out.stats.map((s) => JSON.stringify(s)).join("\n") + "\n");
    } catch {
      // Stats are for the usage report; losing them must not change what the model sees.
    }
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: out.updated } }),
    );
  } catch {
    // Print nothing: Claude Code keeps the tool's own output.
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "out";
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}
