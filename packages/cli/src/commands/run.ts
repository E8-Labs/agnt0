import pc from "picocolors";
import { type Context, requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { ensureExcluded, isGitRepo } from "../git.js";
import { requireProject } from "../project.js";
import { runLoop, type RunExit } from "../run/loop.js";
import { ClaudeRunner } from "../runners/claude.js";
import { CodexRunner } from "../runners/codex.js";

export async function runCommand(ctx: Context, opts: { watch?: boolean; once?: boolean }): Promise<RunExit> {
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
  try {
    const exit = await runLoop({
      api: ctx.api,
      projectId: project.project_id,
      repoRoot: project.root,
      webUrl: ctx.webUrl,
      runners: [new ClaudeRunner(), new CodexRunner()],
      watch: opts.watch,
      maxSteps: opts.once ? 1 : undefined,
      signal: ac.signal,
    });
    if (exit.status === "paused") console.log(pc.yellow("paused"));
    if (exit.status === "interrupted") process.exitCode = 130;
    return exit;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
}
