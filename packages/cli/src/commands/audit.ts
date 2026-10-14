import { AuditRun, m2routes, m2routesApi } from "@agnt0/protocol";
import pc from "picocolors";
import { pendingAudit } from "../audit.js";
import { type Context, requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { requireProject } from "../project.js";
import type { RunExit } from "../run/loop.js";
import { runCommand } from "./run.js";

export interface AuditOptions {
  static?: boolean;
  run?: boolean;
  skip?: boolean;
}

export async function auditCommand(ctx: Context, opts: AuditOptions, log: (l: string) => void = console.log, run: typeof runCommand = runCommand): Promise<{ audit: AuditRun; exit?: RunExit }> {
  await requireLogin(ctx);
  const project = await requireProject();

  if (opts.skip) {
    const pending = await pendingAudit(ctx.api, project.project_id);
    if (!pending) throw new CliError("There's no queued or running audit to skip.");
    const audit = await ctx.api.post(m2routesApi.auditSkip(pending.id), { schema: AuditRun });
    log(`${pc.green("✓")} Skipped the audit ${pc.dim(audit.id)}. The Planner can start: ${pc.cyan("agnt0 run")}`);
    return { audit };
  }

  const audit = await ctx.api.post(m2routes.audits(project.project_id), { body: { mode: opts.static ? "static" : "full", trigger: "manual" }, schema: AuditRun });
  const mode = audit.mode === "static" ? "static checks only" : "static checks + running the app";
  if (audit.status === "running") {
    log(`${pc.cyan("◆")} An audit is already running ${pc.dim(`(${audit.id} · ${mode})`)}. Follow it with ${pc.cyan("agnt0 watch")} or on the dashboard.`);
    return { audit };
  }
  log(`${pc.cyan("◆")} Code audit queued ${pc.dim(`(${audit.id} · ${mode})`)}`);
  log(`  Estimate: ~${pc.bold(String(audit.estimate_credits))} credits. Nothing is changed in your repo; findings go to Code health.`);
  if (opts.run === false) {
    log(`  It runs first on your next ${pc.cyan("agnt0 run")}.`);
    return { audit };
  }
  log(pc.dim("  Running it now (one step)…"));
  log("");
  const exit = await run(ctx, { once: true });
  if (exit.status === "idle" && exit.reason === "max_steps") log(pc.dim(`  Continue building with ${pc.cyan("agnt0 run")}.`));
  return { audit, exit };
}
