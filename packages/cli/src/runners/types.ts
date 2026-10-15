import type { Runner, Step, StepEvent, TokenUsage } from "@agnt0/protocol";

export interface RunnerInput {
  /** Held in memory only. Never write `step.prompt` to disk or logs. */
  step: Step;
  cwd: string;
  signal: AbortSignal;
  onEvent: (event: StepEvent) => void;
  /** Project env vars to add to the runner's environment (already filtered; never logged). */
  env?: Record<string, string>;
  /**
   * Directories holding this step's skills, already verified and unpacked. Claude Code loads them
   * with `--plugin-dir`; Codex reads its own from the worktree, so it ignores this.
   */
  pluginDirs?: string[];
  /** Settings file for this run only, carrying the compression hook. */
  settingsPath?: string | null;
}

export interface RunnerResult {
  ok: boolean;
  /** Final text from the agent (trimmed to the protocol limit by the caller). */
  finalText: string;
  usage: TokenUsage;
  error?: string;
}

export interface RunnerAdapter {
  readonly id: Runner;
  readonly label: string;
  /** Installed and runnable (does not check login). */
  isAvailable(): Promise<boolean>;
  run(input: RunnerInput): Promise<RunnerResult>;
}

export function zeroUsage(runner: Runner, model: string): TokenUsage {
  return {
    runner,
    model,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    raw_tool_tokens: 0,
    sent_tool_tokens: 0,
  };
}
