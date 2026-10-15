import {
  AuditOutput,
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
import { EMPTY_SKILLS, loadStepSkills, type LoadedSkills } from "../runners/skills.js";
import { zeroUsage, type RunnerAdapter } from "../runners/types.js";
import { truncate } from "../ui.js";
import { CLI_VERSION } from "../version.js";
import { createCheckpointRef, postCheckpoint } from "../checkpoint.js";
import { git } from "../git.js";
import { finalizeWorktree, measureRoot, WorktreeManager, type DiffResult } from "../worktree.js";
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
  /**
   * How many steps to run at once (default 1). The server clamps this to the project's and the
   * plan's own agent limits, so asking for more than the account allows is harmless.
   */
  parallel?: number;
  /** Stop after this many steps (tests, `--once`). */
  maxSteps?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
  idlePollMs?: number;
  pausePollMs?: number;
  eventFlushMs?: number;
  /** Project env vars for the runner's environment (already filtered for the runner). */
  env?: Record<string, string>;
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

  const parallel = Math.max(1, Math.min(MAX_PARALLEL, Math.trunc(opts.parallel ?? 1)));

  let steps = 0;
  let creditsThisRun = 0;
  let offlineSince: number | null = null;

  /**
   * Steps running right now. With `parallel > 1` the loop keeps leasing until either the slots are
   * full or the server says there is nothing ready, then waits for one to finish before asking again.
   */
  const inflight = new Set<Promise<Outcome>>();
  /** Set once something says to stop starting new work; in-flight steps still finish and report. */
  let stopLeasing: RunExit | null = null;
  let failure: unknown = null;

  const startStep = (step: Step) => {
    steps++;
    currentRunner = step.runner;
    setState("running");
    const stepLog = parallel > 1 ? taggedLog(log, step) : log;
    const p: Promise<Outcome> = executeStep(step, { ...opts, log: stepLog, signal, available }).then(
      (res) => ({ step, res }),
      (err: unknown) => ({ step, err }),
    );
    inflight.add(p);
  };

  /** Waits for the first in-flight step to finish and applies its result. */
  const settleOne = async (): Promise<void> => {
    if (!inflight.size) return; // Promise.race([]) would never settle.
    const { p, out } = await Promise.race([...inflight].map(async (p) => ({ p, out: await p })));
    inflight.delete(p);

    if ("err" in out) {
      // Keep the first error, stop taking new work, let the others report themselves, rethrow after.
      failure ??= out.err;
      stopLeasing ??= { status: "interrupted" };
      return;
    }
    const res = out.res;
    if (res === "interrupted") {
      stopLeasing ??= { status: "interrupted" };
      return;
    }
    creditsThisRun += res.credits_charged;
    for (const w of usageWarnings(res.usage)) log(w);
    if (res.next === "pause_limit") {
      setState("paused");
      log(`${pc.yellow("⏸")}  Paused: usage limit reached. Run ${pc.cyan("agnt0 usage")} for the reset time, or ${pc.cyan("agnt0 credits use")} / ${pc.cyan("agnt0 upgrade")} to keep going.`);
      stopLeasing ??= { status: "paused", code: "limit_reached" };
    }
    if (opts.maxSteps !== undefined && steps >= opts.maxSteps) {
      stopLeasing ??= { status: "idle", reason: "max_steps", message: `Stopped after ${steps} step(s).` };
    }
  };

  /** Lets every running step finish and report before the loop returns. */
  const drain = async (): Promise<void> => {
    while (inflight.size) await settleOne();
  };

  try {
    for (;;) {
      if (signal.aborted) {
        await drain();
        if (failure) throw failure;
        return { status: "interrupted" };
      }
      // Something asked us to stop: let the running steps report, then return that reason.
      if (stopLeasing) {
        await drain();
        if (failure) throw failure;
        // `watch` keeps going after a pause, but only once nothing is in flight.
        if (stopLeasing.status === "paused" && opts.watch) {
          const resume = stopLeasing;
          stopLeasing = null;
          await sleep(opts.pausePollMs ?? 60_000);
          if (signal.aborted) return { status: "interrupted" };
          debug("resuming after pause", resume.code);
          continue;
        }
        return stopLeasing;
      }
      // All slots busy: wait for one before asking for more work.
      if (inflight.size >= parallel) {
        await settleOne();
        continue;
      }

      let next: StepNextResponse;
      try {
        next = await api.post(routes.stepsNext(projectId), {
          body: { runner_available: runnerIds, repo_sha: await headSha(repoRoot), max_parallel: parallel },
          schema: StepNextResponse,
          signal,
        });
        offlineSince = null;
      } catch (e) {
        if (signal.aborted) {
          await drain();
          if (failure) throw failure;
          return { status: "interrupted" };
        }
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
          stopLeasing ??= { status: "paused", code: e.code ?? "payment_required" };
          continue;
        }
        throw e;
      }

      if (next.kind === "idle") {
        // Nothing ready *yet* is not the same as nothing to do: a step still running will unlock the
        // tickets that depend on it, so wait for it rather than reporting the project idle.
        if (inflight.size) {
          await settleOne();
          continue;
        }
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

      startStep(next.step);
      // One slot is the sequential loop: finish this step before asking for the next.
      if (parallel === 1) await settleOne();
      else if (opts.maxSteps !== undefined && steps >= opts.maxSteps) stopLeasing ??= { status: "idle", reason: "max_steps", message: `Stopped after ${steps} step(s).` };
    }
  } finally {
    clearInterval(hb);
  }
}

/** The protocol caps a lease request at 8 agents. */
const MAX_PARALLEL = 8;

type Outcome = { step: Step; res: StepCompleteResponse | "interrupted" } | { step: Step; err: unknown };

/**
 * Several agents running at once interleave their output, so each line says which ticket it came
 * from. Short enough to stay out of the way: `tkt_dhz8ibx1t1shejvb` prints as `[dhz8ib]`.
 */
function taggedLog(log: (line: string) => void, step: Step): (line: string) => void {
  const id = step.ticket_id ? step.ticket_id.replace(/^tkt_/, "").slice(0, 6) : step.kind;
  const tag = pc.dim(`[${id}]`);
  return (line: string) => log(`${tag} ${line}`);
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
  // Audits are read-only: repo root, no worktree, no checkpoint, no commit.
  const isAudit = step.kind === "audit";
  const statusBefore = isAudit ? await porcelain(repoRoot) : null;
  try {
    if (step.worktree && !isAudit) {
      const mgr = new WorktreeManager(repoRoot);
      const w = await mgr.ensure(step.worktree, step.branch, step.base_branch ?? null);
      cwd = w.path;
      wt = w;
      log(pc.dim(`  worktree ${relative(repoRoot, w.path)} on ${w.branch}${w.created ? " (new)" : ""}`));
    }
    if (step.checkpoint_before && !isAudit && (await headSha(cwd))) {
      const cp = await createCheckpointRef(cwd, step.step_id, `agnt0 checkpoint before ${step.kind} ${ticket}`);
      if (cp) {
        log(pc.dim(`  checkpoint ${cp.ref}`));
        const rec = await postCheckpoint(api, step.project_id, {
          name: `Before ${who} ${step.kind} · ${ticket}`,
          git_sha: cp.sha,
          git_ref: cp.ref,
          created_by: "agent",
          step_id: step.step_id,
        });
        if (rec) debug("checkpoint recorded", rec.id);
      }
      if (wt) wt.baseSha = (await headSha(cwd)) ?? wt.baseSha;
    }
  } catch (e) {
    deps.signal.removeEventListener("abort", onAbort);
    const msg = e instanceof Error ? e.message : String(e);
    log(pc.red(`  ${msg}`));
    return fail(`Workspace setup failed: ${msg}`);
  }

  // Skills for this step only: verified, unpacked outside the repo where the runner allows it, and
  // deleted below. A skill that fails to load is reported and skipped rather than failing the step.
  let skills: LoadedSkills = EMPTY_SKILLS;
  try {
    skills = await loadStepSkills(step, { cwd, repoRoot });
    if (skills.loaded.length) {
      log(pc.dim(`  skills ${skills.loaded.map((s) => `${s.slug}@${s.version}${s.cached ? "" : " (step only)"}`).join(", ")}`));
    }
    for (const p of skills.problems) log(pc.yellow(`  ! skill not loaded — ${truncate(p, 160)}`));
  } catch (e) {
    log(pc.yellow(`  ! skills could not be prepared: ${truncate(e instanceof Error ? e.message : String(e), 160)}`));
  }

  let lastShown = 0;
  const approvals: string[] = [];
  let result: Awaited<ReturnType<RunnerAdapter["run"]>>;
  try {
    result = await runner.run({
      step,
      cwd,
      ...(skills.pluginDirs.length ? { pluginDirs: skills.pluginDirs } : {}),
      signal: ac.signal,
      ...(deps.env && Object.keys(deps.env).length ? { env: deps.env } : {}),
      onEvent: (e) => {
        batcher.push(e);
        const category = typeof e.data?.approval_needed === "string" ? e.data.approval_needed : null;
        if (category) {
          if (!approvals.includes(category)) approvals.push(category);
          // Claude Code's own explanation when it gave one, otherwise the command we inferred from.
          const why = typeof e.data?.reason === "string" ? e.data.reason : e.summary.replace(/^needs approval: \S+ /, "");
          log(`  ${pc.yellow("needs approval:")} ${category} ${pc.dim(truncate(why, 140))}`);
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
    await skills.cleanup();
    const msg = e instanceof Error ? e.message : String(e);
    log(pc.red(`  ${msg}`));
    const res = await fail(msg);
    return deps.signal.aborted ? "interrupted" : res;
  }
  deps.signal.removeEventListener("abort", onAbort);
  // Before the diff is measured: our own skills do not outlive the step that used them.
  await skills.cleanup();

  let diff: DiffResult | undefined;
  if (isAudit) {
    const after = await porcelain(repoRoot);
    if (statusBefore !== null && after !== null && after !== statusBefore) {
      log(pc.yellow(`  ! The audit changed files in your repo (it should be read-only). Review them with \`git status\`.`));
    }
  } else {
    try {
      diff = wt ? await finalizeWorktree(wt.path, wt.baseSha, `agnt0: ${ticket} ${step.role}`) : await measureRoot(repoRoot);
    } catch (e) {
      debug("diff failed", e);
    }
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
  if (isAudit && outcome === "succeeded") for (const l of auditSummaryLines(output, deps.webUrl, step.project_id)) log(l);
  return interrupted ? "interrupted" : res;
}

async function porcelain(root: string): Promise<string | null> {
  try {
    return await git(root, ["status", "--porcelain", "--untracked-files=all"]);
  } catch {
    return null;
  }
}

/** "Code health 72/100 · 3 high · dead code 4, unwired call 1" + where to read the report. */
export function auditSummaryLines(output: unknown, webUrl: string, projectId: string): string[] {
  const parsed = AuditOutput.safeParse(output);
  if (!parsed.success) return [pc.dim(`  Audit report: ${webUrl}/p/${projectId}/code-health`)];
  const a = parsed.data;
  const byKind = new Map<string, number>();
  for (const f of a.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  const high = a.findings.filter((f) => f.severity === "high").length;
  const kinds = [...byKind].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`);
  const score = Math.round(a.score.overall);
  const color = score >= 80 ? pc.green : score >= 50 ? pc.yellow : pc.red;
  return [
    `  ${pc.bold("Code health")} ${color(`${score}/100`)} ${pc.dim("·")} ${a.findings.length} finding${a.findings.length === 1 ? "" : "s"}${high ? ` ${pc.dim("·")} ${pc.red(`${high} high`)}` : ""}`,
    ...(kinds.length ? [`  ${pc.dim(kinds.join(" · "))}`] : []),
    `  ${pc.dim(truncate(a.summary.split("\n")[0] ?? "", 160))}`,
    `  ${pc.dim("Report:")} ${webUrl}/p/${projectId}/code-health ${pc.dim("(pick findings to turn into tickets)")}`,
  ];
}
