import type { RealtimeEvent } from "@agnt0/protocol";
import pc from "picocolors";
import { debug } from "../config.js";
import { loadDevEnv, splitForRunner } from "../env.js";
import { type Context, requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { ensureExcluded, isGitRepo } from "../git.js";
import { requireProject } from "../project.js";
import { runLoop, type RunExit } from "../run/loop.js";
import { ClaudeRunner } from "../runners/claude.js";
import { CodexRunner } from "../runners/codex.js";

/** What `run --watch` / `watch` print when the dashboard asks for a rollback (never executed automatically). */
export function restoreRequestedLines(ev: Extract<RealtimeEvent, { type: "checkpoint.restore_requested" }>): string[] {
  return [
    `${pc.yellow("↺")} Rollback requested from the dashboard: ${pc.bold(ev.checkpoint.name)} ${pc.dim(`(${ev.checkpoint.git_sha.slice(0, 12)})`)}`,
    `   To restore it, run: ${pc.cyan(`agnt0 rollback ${ev.checkpoint.id}`)}   ${pc.dim("(makes a safety checkpoint and a new branch first)")}`,
  ];
}

export async function runCommand(ctx: Context, opts: { watch?: boolean; once?: boolean; parallel?: number }): Promise<RunExit> {
  await requireLogin(ctx);
  const project = await requireProject();
  if (!(await isGitRepo(project.root))) throw new CliError(`${project.root} isn't a git repository.`, "Run `git init` there, or `agnt0 init` again.");
  if (project.api_url !== ctx.apiUrl) {
    console.log(pc.yellow(`! This project was linked against ${project.api_url}, but agnt0 is talking to ${ctx.apiUrl}.`));
  }
  await ensureExcluded(project.root);

  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      console.log(pc.yellow("\nStopping… reporting the current step as interrupted (Ctrl-C again to force quit)."));
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  console.log(`${pc.bold("agnt0 run")} ${pc.dim(`· ${project.name ?? project.project_id} · ${ctx.apiUrl}`)}`);
  const { env, heldBack } = splitForRunner(await loadDevEnv(ctx.api, project.project_id));
  const n = Object.keys(env).length;
  if (n || heldBack.length) {
    console.log(pc.dim(`  env: ${n} dev var${n === 1 ? "" : "s"} injected${heldBack.length ? ` (kept from the runner: ${heldBack.join(", ")})` : ""}`));
  }

  // `--watch` also listens on the project channel so dashboard rollback requests reach the terminal.
  let unsubscribe: (() => void) | null = null;
  if (opts.watch) {
    try {
      const { createWatchSource } = await import("../watch/source.js");
      const source = createWatchSource({ api: ctx.api, apiUrl: ctx.apiUrl, projectId: project.project_id, tokens: ctx.session });
      unsubscribe = source.subscribe({
        onEvent: (ev) => {
          if (ev.type === "checkpoint.restore_requested") for (const l of restoreRequestedLines(ev)) console.log(l);
        },
        onStatus: () => {},
      });
    } catch (e) {
      debug("realtime subscribe failed", e);
    }
  }
  try {
    const exit = await runLoop({
      api: ctx.api,
      projectId: project.project_id,
      repoRoot: project.root,
      webUrl: ctx.webUrl,
      runners: [new ClaudeRunner(), new CodexRunner()],
      watch: opts.watch,
      // `--once` means one step, so it overrides a parallel request rather than racing several.
      parallel: opts.once ? 1 : opts.parallel,
      maxSteps: opts.once ? 1 : undefined,
      signal: ac.signal,
      env,
    });
    if (exit.status === "paused") console.log(pc.yellow("paused"));
    if (exit.status === "interrupted") process.exitCode = 130;
    return exit;
  } finally {
    unsubscribe?.();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}
