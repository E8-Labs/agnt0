import type { StepEvent, TokenUsage } from "@agnt0/protocol";
import type { Step } from "@agnt0/protocol";
import { modelForTier } from "./codex-models.js";
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

/** Read-only for steps that only look (plan, review, audit); workspace-write (no network) for builds. */
export function codexSandbox(step: Pick<Step, "kind">): "read-only" | "workspace-write" {
  return step.kind === "plan" || step.kind === "review" || step.kind === "audit" ? "read-only" : "workspace-write";
}

export interface CodexArgsOptions {
  /** The step's working root, so Codex writes inside the ticket worktree and nowhere else. */
  cwd?: string;
  /** Resolved from the installed Codex's own catalog; omitted when it could not be read. */
  model?: { model: string | null; reasoningEffort: string | null };
}

export function codexArgs(step: Pick<Step, "kind">, opts: CodexArgsOptions = {}): string[] {
  // No --full-auto: the sandbox is chosen per step kind. Prompt on stdin ("-").
  const args = ["exec", "--json", "--sandbox", codexSandbox(step)];
  // Role prompts are server-only text and must not reach the disk, so the session is never saved.
  // This is the Codex counterpart of Claude Code's --no-session-persistence.
  args.push("--ephemeral");
  args.push("--skip-git-repo-check");
  // Be explicit about the working root: the worktree lives inside the repo, and without this Codex
  // is free to treat the enclosing repository as the workspace it may write to.
  if (opts.cwd) args.push("--cd", opts.cwd);
  if (opts.model?.model) args.push("--model", opts.model.model);
  if (opts.model?.reasoningEffort) args.push("-c", `model_reasoning_effort="${opts.model.reasoningEffort}"`);
  args.push("-");
  return args;
}

/**
 * Drives the user's own Codex headlessly (`codex exec --json`) with the prompt on stdin.
 *
 * **How a step is confined.** The sandbox does all of it: `read-only` for steps that only look,
 * `workspace-write` — which also blocks network — for steps that change code. There is no
 * per-command approval layer, and that is Codex's design rather than something missing here:
 * `codex exec` pins its approval policy to `Never`, because a headless run has nobody to ask. A
 * command that asks to escalate out of the sandbox is refused outright, logged by Codex as
 * "approval policy is Never; reject command", and the turn carries on. So a step's
 * `requires_approval` categories end up denied rather than prompted — the same outcome as the
 * Claude runner, which maps them to `--disallowedTools`.
 *
 * Codex's execpolicy (`prefix_rule` in Starlark `.rules` files) is not a way around this: it records
 * approvals a user has already granted interactively, and `codex exec` never reads one. Verified by
 * tracing every file open of a real turn, including with `approval_policy.granular.rules = true`.
 */
export class CodexRunner implements RunnerAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex";
  constructor(private readonly bin = process.env.AGNT0_CODEX_BIN ?? "codex") {}

  async isAvailable(): Promise<boolean> {
    return (await commandVersion(this.bin)) !== null;
  }

  async run({ step, cwd, signal, onEvent, env }: RunnerInput): Promise<RunnerResult> {
    const model = await modelForTier(this.bin, step.model);
    // Report the model Codex actually ran, not the tier we asked for, so usage lands against a real
    // model. Falls back to the tier when the catalog could not be read and Codex picked for itself.
    const parser = new CodexStreamParser(model.model ?? step.model);
    const args = codexArgs(step, { cwd, model });
    const proc = await runLines(this.bin, args, { cwd, input: step.prompt, signal, onLine: (l) => parser.push(l).forEach(onEvent), env });
    const usage = parser.usage();
    if (proc.aborted) return { ok: false, finalText: parser.lastMessage, usage, error: "interrupted" };
    if (proc.spawnError) return { ok: false, finalText: "", usage, error: `Could not start Codex: ${proc.spawnError}` };
    if (proc.exitCode !== 0 || parser.failed) {
      return { ok: false, finalText: parser.lastMessage, usage, error: parser.failed ?? `Codex exited with code ${proc.exitCode}: ${proc.stderr.trim().split("\n").slice(-3).join("\n")}` };
    }
    return { ok: true, finalText: parser.lastMessage, usage };
  }
}
