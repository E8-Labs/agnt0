import type { Checkpoint } from "@agnt0/protocol";
import pc from "picocolors";
import {
  commitExists,
  createCheckpointRef,
  listCheckpoints,
  listLocalCheckpointRefs,
  postCheckpoint,
  resolveRollbackTarget,
  rollbackTo,
  stamp,
  type RollbackResult,
} from "../checkpoint.js";
import { debug } from "../config.js";
import { type Context, requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { ensureExcluded, headSha, isGitRepo } from "../git.js";
import { requireProject, type LinkedProject } from "../project.js";
import { confirm, isInteractive, ttyAsk, type Ask } from "../prompt.js";
import { relTime, table, truncate } from "../ui.js";

async function linkedRepo(): Promise<LinkedProject> {
  const project = await requireProject();
  if (!(await isGitRepo(project.root))) throw new CliError(`${project.root} isn't a git repository.`);
  return project;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function checkpointCommand(ctx: Context, name: string | undefined, log: (l: string) => void = console.log): Promise<Checkpoint | { ref: string; sha: string }> {
  await requireLogin(ctx);
  const project = await linkedRepo();
  if (!(await headSha(project.root))) throw new CliError("This repository has no commits yet.", "Make a first commit, then take a checkpoint.");
  await ensureExcluded(project.root);
  const label = (name ?? "").trim() || `Checkpoint ${new Date().toLocaleString()}`;
  const id = `user/${stamp()}${name ? `-${slug(name)}` : ""}`;
  const local = await createCheckpointRef(project.root, id, `agnt0 checkpoint: ${label}`);
  if (!local) throw new CliError("Nothing to checkpoint yet.");
  const rec = await postCheckpoint(ctx.api, project.project_id, { name: label, git_sha: local.sha, git_ref: local.ref, created_by: "user" });
  if (rec) {
    log(`${pc.green("✓")} Checkpoint ${pc.bold(rec.name)} ${pc.dim(`${rec.id} · ${local.sha.slice(0, 12)}`)}`);
    log(pc.dim(`  ${local.ref} (includes uncommitted and untracked files). Restore with: agnt0 rollback ${rec.id}`));
    return rec;
  }
  log(`${pc.green("✓")} Checkpoint saved locally ${pc.dim(`${local.ref} · ${local.sha.slice(0, 12)}`)}`);
  log(pc.yellow(`! Couldn't record it on your dashboard; it still works here: agnt0 rollback ${id}`));
  return local;
}

export async function checkpointsCommand(ctx: Context, opts: { json?: boolean } = {}, log: (l: string) => void = console.log): Promise<Checkpoint[]> {
  await requireLogin(ctx);
  const project = await linkedRepo();
  let remote: Checkpoint[] | null = null;
  try {
    remote = await listCheckpoints(ctx.api, project.project_id);
  } catch (e) {
    debug("checkpoint list failed", e);
  }
  if (opts.json) {
    log(JSON.stringify(remote ?? [], null, 2));
    return remote ?? [];
  }
  if (remote === null) {
    const local = await listLocalCheckpointRefs(project.root);
    log(pc.yellow("! Couldn't load checkpoints from Agent Zero; showing the ones in this repo."));
    if (!local.length) log(pc.dim("  none yet"));
    else log(table([[pc.dim("REF"), pc.dim("SHA"), pc.dim("CREATED")], ...local.slice(0, 30).map((c) => [c.ref.replace("refs/agnt0/checkpoints/", ""), c.sha.slice(0, 12), relTime(c.date)])]));
    return [];
  }
  if (!remote.length) {
    log(`No checkpoints yet. Take one with ${pc.cyan("agnt0 checkpoint [name]")}; ${pc.cyan("agnt0 run")} takes one before every build step.`);
    return remote;
  }
  const rows: string[][] = [[pc.dim("ID"), pc.dim("NAME"), pc.dim("BY"), pc.dim("SHA"), pc.dim("CREATED"), ""]];
  for (const c of remote.slice(0, 50)) {
    const here = await commitExists(project.root, c.git_sha);
    rows.push([c.id, truncate(c.name, 48), c.created_by, c.git_sha.slice(0, 12), relTime(c.created_at), here ? "" : pc.dim("not in this repo")]);
  }
  log(table(rows));
  if (remote.length > 50) log(pc.dim(`  …and ${remote.length - 50} older`));
  log(pc.dim(`  Restore one with: agnt0 rollback <id>`));
  return remote;
}

export async function rollbackCommand(
  ctx: Context,
  id: string,
  opts: { yes?: boolean } = {},
  log: (l: string) => void = console.log,
  ask: Ask | null = isInteractive() ? ttyAsk : null,
): Promise<RollbackResult | null> {
  await requireLogin(ctx);
  const project = await linkedRepo();
  await ensureExcluded(project.root);
  const target = await resolveRollbackTarget(ctx.api, project.project_id, project.root, id);

  if (!opts.yes) {
    if (!ask) throw new CliError("Rolling back needs confirmation.", `Run it in a terminal, or pass --yes: agnt0 rollback ${id} --yes`);
    log(`Roll back to ${pc.bold(target.name)} ${pc.dim(`(${target.sha.slice(0, 12)})`)}?`);
    log(pc.dim("  First a safety checkpoint of everything as it is now (including uncommitted and untracked files),"));
    log(pc.dim("  then the checkpoint is restored on a new branch. Your current branch is left untouched; nothing is deleted."));
    if (!(await confirm(ask, "Continue?", false))) {
      log("Cancelled.");
      return null;
    }
  }

  const res = await rollbackTo(project.root, target, {
    onSafety: async (safety) => {
      await postCheckpoint(ctx.api, project.project_id, { name: `Before rollback to ${target.name}`, git_sha: safety.sha, git_ref: safety.ref, created_by: "user" });
    },
  });
  log(`${pc.green("✓")} Rolled back to ${pc.bold(target.name)} on new branch ${pc.cyan(res.branch)}`);
  if (res.safety) log(pc.dim(`  Safety checkpoint: ${res.safety.ref} (${res.safety.sha.slice(0, 12)})`));
  const back = res.previousBranch ?? res.previousSha?.slice(0, 12) ?? "-";
  log(pc.dim(`  Back to where you were: git switch ${back}`));
  if (res.safety && res.safety.sha !== res.previousSha) {
    log(pc.dim(`  Your uncommitted changes are saved too; bring them back with: git switch ${back} && git restore --source=${res.safety.sha.slice(0, 12)} --worktree -- :/`));
  }
  return res;
}
