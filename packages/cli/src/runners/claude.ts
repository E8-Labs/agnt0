import type { Step } from "@agnt0/protocol";
import { ClaudeStreamParser } from "./claude-stream.js";
import { commandVersion, runLines } from "./spawn.js";
import { CLAUDE_MODEL_ALIASES, mapClaudePermissions } from "./tools.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "./types.js";

export function claudeArgs(step: Step, pluginDirs: string[] = []): string[] {
  const perms = mapClaudePermissions(step.allowed_tools, step.scope, step.approval.requires_approval);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Keep the step prompt off disk (~/.claude/projects/*.jsonl).
    "--no-session-persistence",
    "--max-turns",
    String(Math.max(1, Math.min(500, Math.trunc(step.max_turns)))),
    "--model",
    CLAUDE_MODEL_ALIASES[step.model],
  ];
  if (perms.permissionMode) args.push("--permission-mode", perms.permissionMode);
  // This session only: the skills are gone from disk when the step ends, and nothing is written to
  // the user's global settings or their repo.
  for (const dir of pluginDirs) args.push(`--plugin-dir=${dir}`);
  // `--flag=value` keeps every rule attached to its flag, so no value can ever be read as an option.
  for (const t of perms.allowed) args.push(`--allowedTools=${t}`);
  for (const t of perms.disallowed) args.push(`--disallowedTools=${t}`);
  // The prompt itself is sent on stdin.
  return args;
}

/** Drives the user's own Claude Code headlessly (`claude -p … --output-format stream-json`). */
export class ClaudeRunner implements RunnerAdapter {
  readonly id = "claude" as const;
  readonly label = "Claude Code";
  constructor(private readonly bin = process.env.AGNT0_CLAUDE_BIN ?? "claude") {}

  async isAvailable(): Promise<boolean> {
    return (await commandVersion(this.bin)) !== null;
  }

  async run({ step, cwd, signal, onEvent, env, pluginDirs }: RunnerInput): Promise<RunnerResult> {
    const parser = new ClaudeStreamParser(CLAUDE_MODEL_ALIASES[step.model]);
    const args = claudeArgs(step, pluginDirs ?? []); // throws on an unsafe tool grant before anything runs
    const proc = await runLines(this.bin, args, {
      cwd,
      input: step.prompt,
      signal,
      onLine: (line) => parser.push(line).forEach(onEvent),
      env,
    });
    const usage = parser.usage();
    const finalText = parser.finalText();
    if (proc.aborted) return { ok: false, finalText, usage, error: "interrupted" };
    if (proc.spawnError) return { ok: false, finalText, usage, error: `Could not start Claude Code: ${proc.spawnError}` };
    if (parser.subtype === "error_max_turns") return { ok: false, finalText, usage, error: `Reached the step's turn limit (${step.max_turns}).` };
    if (proc.exitCode !== 0 || parser.isError || !parser.sawResult) {
      const tail = proc.stderr.trim().split("\n").slice(-5).join("\n");
      const reason = parser.isError ? `Claude Code reported an error${parser.subtype ? ` (${parser.subtype})` : ""}` : `Claude Code exited with code ${proc.exitCode}`;
      return { ok: false, finalText, usage, error: tail ? `${reason}: ${tail}` : reason };
    }
    return { ok: true, finalText, usage };
  }
}
