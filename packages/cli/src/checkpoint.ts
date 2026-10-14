import { Checkpoint, CheckpointList, m2routes } from "@agnt0/protocol";
import { copyFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ApiClient } from "./api/client.js";
import { debug } from "./config.js";
import { ApiHttpError, CliError } from "./errors.js";
import { git, gitEnv, gitOk, headSha, identityArgs } from "./git.js";

export const CHECKPOINT_REF_PREFIX = "refs/agnt0/checkpoints/";

export function safeRefPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/\.\.+/g, ".").replace(/\/\/+/g, "/").replace(/^[-/.]+|[/.]+$/g, "") || "x";
}

/**
 * A commit holding the whole working tree (tracked changes plus untracked files, honouring ignores)
 * without touching HEAD, the index or any file: it stages into a throwaway copy of the index.
 * Returns HEAD itself when the tree is clean, or null in a repo without commits and without files.
 */
export async function snapshotWorkingTree(cwd: string, message: string): Promise<string | null> {
  const head = await headSha(cwd);
  let indexPath = await git(cwd, ["rev-parse", "--git-path", "index"]);
  if (!isAbsolute(indexPath)) indexPath = join(cwd, indexPath);
  const tmpIndex = `${indexPath}.agnt0-${process.pid}-${Date.now()}`;
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    let seeded = false;
    try {
      await copyFile(indexPath, tmpIndex);
      seeded = true;
    } catch {
      /* no index yet */
    }
    if (!seeded && head) await gitEnv(cwd, ["read-tree", head], env);
    await gitEnv(cwd, ["add", "-A"], env);
    const tree = await gitEnv(cwd, ["write-tree"], env);
    if (head && (await git(cwd, ["rev-parse", `${head}^{tree}`])) === tree) return head;
    if (!head && !(await gitEnv(cwd, ["ls-files"], env))) return null;
    const id = await identityArgs(cwd);
    return await git(cwd, [...id, "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message]);
  } finally {
    await rm(tmpIndex, { force: true });
  }
}

export interface LocalCheckpoint {
  ref: string;
  sha: string;
}

/** Points `refs/agnt0/checkpoints/<id>` at a snapshot of the working tree. */
export async function createCheckpointRef(cwd: string, id: string, message = `agnt0 checkpoint ${id}`): Promise<LocalCheckpoint | null> {
  const sha = await snapshotWorkingTree(cwd, message);
  if (!sha) return null;
  const ref = `${CHECKPOINT_REF_PREFIX}${safeRefPart(id)}`;
  await git(cwd, ["update-ref", ref, sha]);
  return { ref, sha };
}

/** `20261013-142501` — sortable, readable, ref-safe. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Records a checkpoint on the server. Returns null (never throws) when the API can't take it. */
export async function postCheckpoint(
  api: ApiClient,
  projectId: string,
  body: { name: string; git_sha: string; git_ref: string; created_by: "agent" | "user"; step_id?: string | null },
): Promise<Checkpoint | null> {
  try {
    return await api.post(m2routes.checkpoints(projectId), { body: { ...body, name: body.name.slice(0, 120) }, schema: Checkpoint });
  } catch (e) {
    debug("checkpoint record failed", e);
    return null;
  }
}

export async function listCheckpoints(api: ApiClient, projectId: string): Promise<Checkpoint[]> {
  return (await api.get(m2routes.checkpoints(projectId), { schema: CheckpointList })).checkpoints;
}

export async function listLocalCheckpointRefs(root: string): Promise<Array<{ ref: string; sha: string; date: string }>> {
  const out = await git(root, ["for-each-ref", "--sort=-creatordate", "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)", CHECKPOINT_REF_PREFIX]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [ref = "", sha = "", date = ""] = l.split("\t");
      return { ref, sha, date };
    });
}

export async function commitExists(root: string, sha: string): Promise<boolean> {
  return gitOk(root, ["cat-file", "-e", `${sha}^{commit}`]);
}

export interface RollbackTarget {
  id: string;
  name: string;
  sha: string;
}

/**
 * Finds what `agnt0 rollback <id>` means: a server checkpoint id, or (offline / local only) a ref name
 * under refs/agnt0/checkpoints/ or a commit sha.
 */
export async function resolveRollbackTarget(api: ApiClient | null, projectId: string | null, root: string, id: string): Promise<RollbackTarget> {
  let apiError: unknown = null;
  if (api && projectId) {
    try {
      const found = (await listCheckpoints(api, projectId)).find((c) => c.id === id);
      if (found) return { id: found.id, name: found.name, sha: found.git_sha };
    } catch (e) {
      apiError = e;
      debug("checkpoint list failed", e);
    }
  }
  const ref = id.startsWith("refs/") ? id : `${CHECKPOINT_REF_PREFIX}${safeRefPart(id)}`;
  const r = await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).catch(() => "");
  if (r) return { id, name: ref.replace(CHECKPOINT_REF_PREFIX, ""), sha: r };
  if (/^[0-9a-f]{7,64}$/.test(id) && (await commitExists(root, id))) return { id, name: id.slice(0, 12), sha: await git(root, ["rev-parse", `${id}^{commit}`]) };
  if (apiError instanceof ApiHttpError && apiError.status !== 404) throw apiError;
  throw new CliError(`There's no checkpoint ${id}.`, "List them with `agnt0 checkpoints`.");
}

export interface RollbackResult {
  branch: string;
  previousBranch: string | null;
  previousSha: string | null;
  safety: LocalCheckpoint | null;
  commit: string;
}

/**
 * Restores the working tree to `target.sha` without losing anything:
 *  1. snapshots the current tree (tracked + untracked) to a pre-rollback checkpoint ref,
 *  2. switches to a new branch `agnt0/rollback-<stamp>` (your current branch is not touched),
 *  3. makes the index and tracked files match the checkpoint and commits that on the new branch.
 * Untracked files are left where they are; files the checkpoint contains are restored over them
 * (their previous content is in the pre-rollback checkpoint).
 */
export async function rollbackTo(root: string, target: RollbackTarget, opts: { now?: Date; onSafety?: (c: LocalCheckpoint) => Promise<void> } = {}): Promise<RollbackResult> {
  if (!(await commitExists(root, target.sha))) {
    throw new CliError(
      `Checkpoint ${target.id} (${target.sha.slice(0, 12)}) isn't in this repository.`,
      "It was probably made on another machine. Fetch its refs there with `git push <remote> 'refs/agnt0/*:refs/agnt0/*'`.",
    );
  }
  const previousSha = await headSha(root);
  if (!previousSha) throw new CliError("This repository has no commits yet, so there's nothing to roll back.");
  const ts = stamp(opts.now);
  const safety = await createCheckpointRef(root, `pre-rollback-${ts}`, `agnt0 pre-rollback snapshot before restoring ${target.id}`);
  if (safety && opts.onSafety) await opts.onSafety(safety);

  const cur = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const previousBranch = cur === "HEAD" ? null : cur;
  let branch = `agnt0/rollback-${ts}`;
  for (let i = 2; await gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); i++) branch = `agnt0/rollback-${ts}-${i}`;

  await git(root, ["switch", "-q", "-c", branch]);
  await git(root, ["restore", `--source=${target.sha}`, "--staged", "--worktree", "--", ":/"]);
  const id = await identityArgs(root);
  await git(root, [...id, "commit", "-q", "--no-verify", "--allow-empty", "-m", `agnt0: roll back to checkpoint ${target.name} (${target.sha.slice(0, 12)})`]);
  return { branch, previousBranch, previousSha, safety, commit: (await headSha(root)) as string };
}
