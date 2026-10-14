import {
  ROLE_LABELS,
  routes,
  StepCompleteResponse,
  StepNextResponse,
  type Runner,
  type Step,
  type StepCompleteRequest,
  type StepEvent,
} from "@agnt0/protocol";
import pc from "picocolors";
import { relative } from "node:path";
import { NetworkError, realSleep, type ApiClient } from "../api/client.js";
import { debug } from "../config.js";
import { ApiHttpError, CliError } from "../errors.js";
import { headSha } from "../git.js";
import { extractJsonOutput } from "../runners/json-output.js";
import { zeroUsage, type RunnerAdapter } from "../runners/types.js";
import { truncate } from "../ui.js";
import { CLI_VERSION } from "../version.js";
import { createCheckpoint, finalizeWorktree, measureRoot, WorktreeManager, type DiffResult } from "../worktree.js";
import { EventBatcher } from "./events.js";
import { pauseMessage, usageWarnings } from "./limits.js";
import { collectCompletionSummary, formatCompletionSummary } from "./summary.js";

export type RunExit =
  | { status: "idle"; reason: string; message: string }
  | { status: "paused"; code: string }
  | { status: "interrupted" };

export interface RunLoopOptions {
  api: ApiClient;
  projectId: string;
  repoRoot: string;
  webUrl: string;
  runners: RunnerAdapter[];
  watch?: boolean;
  /** Stop after this many steps (tests, `--once`). */
  maxSteps?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
  idlePollMs?: number;
  pausePollMs?: number;
  eventFlushMs?: number;
}

type HeartbeatState = "idle" | "running" | "paused";

/** The build loop: lease a step, run it with the user's own runner, report back, repeat. */
export async function runLoop(opts: RunLoopOptions): Promise<RunExit> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const sleep = opts.sleep ?? realSleep;
  const signal = opts.signal ?? new AbortController().signal;
  const { api, projectId, repoRoot } = opts;

  const available: RunnerAdapter[] = [];
  for (const r of opts.runners) if (await r.isAvailable()) available.push(r);
  if (available.length === 0) {
    throw new CliError("No model runner found. Agent Zero drives your own Claude Code or Codex.", "Install Claude Code (https://claude.com/claude-code), then run `agnt0 doctor`.");
  }
  const runnerIds = available.map((r) => r.id) as Runner[];

  let state: HeartbeatState = "idle";
  let currentRunner: Runner | null = runnerIds[0] ?? null;
  const beat = async () => {
    try {
      await api.post(routes.heartbeat, { body: { project_id: projectId, cli_version: CLI_VERSION, runner: currentRunner, state } });
    } catch (e) {
      debug("heartbeat failed", e);
    }
  };
  void beat();
  const hb = setInterval(() => void beat(), opts.heartbeatMs ?? 30_000);
  hb.unref?.();
  const setState = (s: HeartbeatState) => {
    if (state !== s) {
      state = s;
      void beat();
    }
  };

  let steps = 0;
  let creditsThisRun = 0;
  let offlineSince: number | null = null;
  try {
    for (;;) {
      if (signal.aborted) return { status: "interrupted" };
      let next: StepNextResponse;
      try {
        next = await api.post(routes.stepsNext(projectId), {
          body: { runner_available: runnerIds, repo_sha: await headSha(repoRoot), max_parallel: 1 },
          schema: StepNextResponse,
          signal,
        });
        offlineSince = null;
      } catch (e) {
        if (signal.aborted) return { status: "interrupted" };
        if (e instanceof NetworkError) {
          // Ride out network blips for up to 30 minutes instead of killing the run.
          offlineSince ??= Date.now();
          if (Date.now() - offlineSince > 30 * 60_000) throw e;
          log(pc.dim(`Can't reach Agent Zero; retrying in 15s…`));
          await sleep(15_000);
          continue;
        }
        if (e instanceof ApiHttpError && e.status === 402) {
          setState("paused");
          for (const l of pauseMessage(e, opts.webUrl)) log(l);
          if (opts.watch) {
            await sleep(opts.pausePollMs ?? 60_000);
            continue;
          }
          return { status: "paused", code: e.code ?? "payment_required" };
        }
        throw e;
      }

      if (next.kind === "idle") {
        setState("idle");
        log(`${pc.dim("idle")} ${pc.bold(next.reason.replace(/_/g, " "))}: ${next.message}`);
        if (opts.watch && next.reason !== "all_done") {
          await sleep(opts.idlePollMs ?? 15_000);
          continue;
        }
        if (next.reason === "all_done") {
          try {
            log(formatCompletionSummary(await collectCompletionSummary(api, projectId, repoRoot, creditsThisRun)));
          } catch (e) {
            debug("completion summary failed", e);
          }
        }
        return { status: "idle", reason: next.reason, message: next.message };
      }

      const step = next.step;
      currentRunner = step.runner;
      setState("running");
      const res = await executeStep(step, { ...opts, log, signal, available });
      steps++;
      if (res === "interrupted") return { status: "interrupted" };
      creditsThisRun += res.credits_charged;
      for (const w of usageWarnings(res.usage)) log(w);
      if (res.next === "pause_limit") {
        setState("paused");
        log(`${pc.yellow("⏸")}  Paused: usage limit reached. Run ${pc.cyan("agnt0 usage")} for the reset time, or ${pc.cyan("agnt0 credits use")} / ${pc.cyan("agnt0 upgrade")} to keep going.`);
        if (opts.watch) {
          await sleep(opts.pausePollMs ?? 60_000);
          continue;
        }
        return { status: "paused", code: "limit_reached" };
      }
      if (opts.maxSteps !== undefined && steps >= opts.maxSteps) return { status: "idle", reason: "max_steps", message: `Stopped after ${steps} step(s).` };
    }
  } finally {
    clearInterval(hb);
  }
}

interface ExecDeps extends RunLoopOptions {
  log: (line: string) => void;
  signal: AbortSignal;
  available: RunnerAdapter[];
}

async function executeStep(step: Step, deps: ExecDeps): Promise<StepCompleteResponse | "interrupted"> {
  const { api, repoRoot, log } = deps;
  const started = Date.now();
  const who = ROLE_LABELS[step.role];
  const ticket = step.ticket_id ?? "project";
  log(`${pc.cyan("▶")} ${pc.bold(who)} ${pc.dim(`${step.kind} · ${ticket} · ${step.model} via ${step.runner}`)}`);

  const batcher = new EventBatcher(async (events: StepEvent[]) => {
    await api.post(routes.stepEvents(step.step_id), { body: { events } });
  }, deps.eventFlushMs ?? 2000);
  batcher.start();

  const complete = async (body: StepCompleteRequest): Promise<StepCompleteResponse> => {
    await batcher.stop();
    return api.post(routes.stepComplete(step.step_id), { body, schema: StepCompleteResponse });
  };
  const fail = (error: string, extra: Partial<StepCompleteRequest> = {}) =>
    complete({
      outcome: "failed",
      summary: truncate(error, 8000),
      usage: zeroUsage(step.runner, step.model),
      duration_ms: Date.now() - started,
      error: truncate(error, 2000),
      ...extra,
    });

  const runner = deps.available.find((r) => r.id === step.runner);
  if (!runner) {
    log(pc.red(`  ${step.runner} isn't installed here; reporting the step as failed.`));
    return fail(`Runner "${step.runner}" is not available on this machine.`);
  }

  // Per-step abort: Ctrl-C (the loop signal) stops the runner; we still report the step.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  deps.signal.addEventListener("abort", onAbort, { once: true });

  let cwd = repoRoot;
  let wt: { path: string; baseSha: string } | null = null;
  try {
    if (step.worktree) {
      const mgr = new WorktreeManager(repoRoot);
      const w = await mgr.ensure(step.worktree, step.branch);
      cwd = w.path;
      wt = w;
      log(pc.dim(`  worktree ${relative(repoRoot, w.path)} on ${w.branch}${w.created ? " (new)" : ""}`));
    }
    if (step.checkpoint_before) {
      const ref = await createCheckpoint(cwd, step.step_id);
      if (ref) log(pc.dim(`  checkpoint ${ref}`));
      if (wt) wt.baseSha = (await headSha(cwd)) ?? wt.baseSha;
    }
  } catch (e) {
    deps.signal.removeEventListener("abort", onAbort);
    const msg = e instanceof Error ? e.message : String(e);
    log(pc.red(`  ${msg}`));
    return fail(`Workspace setup failed: ${msg}`);
  }

  let lastShown = 0;
  const approvals: string[] = [];
  let result: Awaited<ReturnType<RunnerAdapter["run"]>>;
  try {
    result = await runner.run({
      step,
      cwd,
      signal: ac.signal,
      onEvent: (e) => {
        batcher.push(e);
        const category = typeof e.data?.approval_needed === "string" ? e.data.approval_needed : null;
        if (category) {
          if (!approvals.includes(category)) approvals.push(category);
          log(`  ${pc.yellow("needs approval:")} ${category} ${pc.dim(truncate(e.summary.replace(/^needs approval: \S+ /, ""), 100))}`);
        } else if (e.data?.permission_denied === true) {
          log(`  ${pc.yellow(truncate(e.summary, 120))}`);
        } else if (e.type !== "message" && Date.now() - lastShown > 250) {
          lastShown = Date.now();
          log(pc.dim(`  ${truncate(e.summary.split("\n")[0] ?? "", 100)}`));
        }
      },
    });
  } catch (e) {
    deps.signal.removeEventListener("abort", onAbort);
    const msg = e instanceof Error ? e.message : String(e);
    log(pc.red(`  ${msg}`));
    const res = await fail(msg);
    return deps.signal.aborted ? "interrupted" : res;
  }
  deps.signal.removeEventListener("abort", onAbort);

  let diff: DiffResult | undefined;
  try {
    diff = wt ? await finalizeWorktree(wt.path, wt.baseSha, `agnt0: ${ticket} ${step.role}`) : await measureRoot(repoRoot);
  } catch (e) {
    debug("diff failed", e);
  }

  const interrupted = deps.signal.aborted || result.error === "interrupted";
  let output: unknown;
  let outcome: "succeeded" | "failed" = result.ok && !interrupted ? "succeeded" : "failed";
  let error = interrupted ? "interrupted" : result.error;

  if (outcome === "succeeded" && step.output_schema) {
    output = extractJsonOutput(result.finalText);
    if (output === undefined) {
      outcome = "failed";
      error = `The ${step.output_schema} step finished without printing the required JSON output.`;
    }
  }

  if (approvals.length && outcome === "failed" && !interrupted) {
    const note = `Blocked actions need approval: ${approvals.join(", ")}.`;
    error = error ? `${error} ${note}` : note;
  }

  const body: StepCompleteRequest = {
    outcome,
    summary: truncate(result.finalText || error || "", 8000),
    ...(output !== undefined ? { output } : {}),
    ...(diff ? { diff } : {}),
    usage: result.usage,
    duration_ms: Date.now() - started,
    ...(error ? { error: truncate(error, 2000) } : {}),
  };

  const res = await complete(body);
  const secs = Math.round(body.duration_ms / 1000);
  const tok = body.usage.input_tokens + body.usage.output_tokens;
  const files = diff ? ` · ${diff.files_changed} files +${diff.lines_added} -${diff.lines_removed}` : "";
  log(`${outcome === "succeeded" ? pc.green("✓") : pc.red("✗")} ${who} ${pc.dim(`${secs}s · ${tok.toLocaleString()} tokens${files} · ${res.credits_charged} credits`)}${error ? pc.red(` ${truncate(error, 200)}`) : ""}`);
  return interrupted ? "interrupted" : res;
}
