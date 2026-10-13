import type { Step } from "@agnt0/protocol";
import { ClaudeStreamParser } from "./claude-stream.js";
import { commandVersion, runLines } from "./spawn.js";
import { CLAUDE_MODEL_ALIASES, mapAllowedToolsForClaude } from "./tools.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "./types.js";

export function claudeArgs(step: Step): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(Math.max(1, step.max_turns)),
    "--model",
    CLAUDE_MODEL_ALIASES[step.model],
    "--permission-mode",
    "acceptEdits",
  ];
  const tools = mapAllowedToolsForClaude(step.allowed_tools, step.scope);
  // Variadic flag goes last; the prompt itself is sent on stdin.
  if (tools.length) args.push("--allowedTools", ...tools);
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

  async run({ step, cwd, signal, onEvent }: RunnerInput): Promise<RunnerResult> {
    const parser = new ClaudeStreamParser(CLAUDE_MODEL_ALIASES[step.model]);
    const proc = await runLines(this.bin, claudeArgs(step), {
      cwd,
      input: step.prompt,
      signal,
      onLine: (line) => parser.push(line).forEach(onEvent),
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
