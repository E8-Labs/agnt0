import type { StepEvent, TokenUsage } from "@agnt0/protocol";
import { commandVersion, runLines } from "./spawn.js";
import { zeroUsage, type RunnerAdapter, type RunnerInput, type RunnerResult } from "./types.js";

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const short = (s: string, max = 2000) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * EXPERIMENTAL. Parses `codex exec --json` JSONL events (thread/turn/item events). The Codex event
 * format has changed between releases, so unknown events are ignored rather than treated as errors.
 */
export class CodexStreamParser {
  private usageTotals = { input: 0, cached: 0, output: 0 };
  lastMessage = "";
  failed: string | null = null;

  constructor(private readonly model = "codex-default") {}

  push(line: string, at = new Date().toISOString()): StepEvent[] {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return [];
    }
    const events: StepEvent[] = [];
    const item = (msg.item ?? {}) as Json;
    if (msg.type === "item.completed" || msg.type === "item.started") {
      if (item.type === "agent_message" && typeof item.text === "string" && msg.type === "item.completed") {
        this.lastMessage = item.text;
        events.push({ type: "message", summary: short(item.text), at });
      } else if (item.type === "command_execution" && msg.type === "item.started") {
        events.push({ type: "tool_call", summary: short(`shell ${String(item.command ?? "")}`), at, data: { tool: "shell" } });
      } else if (item.type === "file_change" && msg.type === "item.completed") {
        const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
        for (const c of changes) events.push({ type: "file_diff", summary: short(`${String(c.kind ?? "edit")} ${String(c.path ?? "")}`), at, data: { file: String(c.path ?? "") } });
      } else if (item.type === "web_search" && msg.type === "item.started") {
        events.push({ type: "browse", summary: short(`search ${String(item.query ?? "")}`), at });
      }
    } else if (msg.type === "turn.completed") {
      const u = (msg.usage ?? {}) as Json;
      this.usageTotals.input += num(u.input_tokens);
      this.usageTotals.cached += num(u.cached_input_tokens);
      this.usageTotals.output += num(u.output_tokens);
    } else if (msg.type === "turn.failed" || msg.type === "error") {
      const err = (msg.error ?? {}) as Json;
      this.failed = String(err.message ?? msg.message ?? "Codex reported an error");
      events.push({ type: "log", summary: short(this.failed), at });
    }
    return events;
  }

  usage(): TokenUsage {
    return {
      ...zeroUsage("codex", this.model),
      input_tokens: this.usageTotals.input,
      output_tokens: this.usageTotals.output,
      cache_read_tokens: this.usageTotals.cached,
    };
  }
}

/** EXPERIMENTAL Codex runner: `codex exec --json` with the prompt on stdin, using the user's Codex login. */
export class CodexRunner implements RunnerAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex (experimental)";
  constructor(private readonly bin = process.env.AGNT0_CODEX_BIN ?? "codex") {}

  async isAvailable(): Promise<boolean> {
    return (await commandVersion(this.bin)) !== null;
  }

  async run({ step, cwd, signal, onEvent }: RunnerInput): Promise<RunnerResult> {
    const parser = new CodexStreamParser();
    // Model tiers are not mapped for Codex yet: the user's configured Codex model is used.
    const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check", "-"];
    const proc = await runLines(this.bin, args, { cwd, input: step.prompt, signal, onLine: (l) => parser.push(l).forEach(onEvent) });
    const usage = parser.usage();
    if (proc.aborted) return { ok: false, finalText: parser.lastMessage, usage, error: "interrupted" };
    if (proc.spawnError) return { ok: false, finalText: "", usage, error: `Could not start Codex: ${proc.spawnError}` };
    if (proc.exitCode !== 0 || parser.failed) {
      return { ok: false, finalText: parser.lastMessage, usage, error: parser.failed ?? `Codex exited with code ${proc.exitCode}: ${proc.stderr.trim().split("\n").slice(-3).join("\n")}` };
    }
    return { ok: true, finalText: parser.lastMessage, usage };
  }
}
