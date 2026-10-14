import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCheckpointRef, safeRefPart } from "./checkpoint.js";
import { commitAll, ensureExcluded, git, gitOk, headSha, parseShortStat, type ShortStat } from "./git.js";

export interface Worktree {
  path: string;
  branch: string;
  /** Commit the worktree pointed at before the step ran; diffs are measured against it. */
  baseSha: string;
  created: boolean;
}

const WT_DIR = join(".agnt0", "wt");


/** One git worktree per leased ticket under `.agnt0/wt/<ticket>`. */
export class WorktreeManager {
  constructor(public readonly repoRoot: string) {}

  /** Resolves a server-provided relative worktree path and refuses anything outside `.agnt0/wt/`. */
  resolvePath(rel: string): string {
    if (isAbsolute(rel)) throw new Error(`Refusing absolute worktree path from server: ${rel}`);
    const abs = resolve(this.repoRoot, rel);
    const base = resolve(this.repoRoot, WT_DIR);
    const r = relative(base, abs);
    if (!r || r.startsWith("..") || isAbsolute(r) || r.split(sep).includes("..")) {
      throw new Error(`Refusing worktree path outside ${WT_DIR}: ${rel}`);
    }
    return abs;
  }

  async list(): Promise<Array<{ path: string; branch: string | null }>> {
    const out = await git(this.repoRoot, ["worktree", "list", "--porcelain"]);
    const items: Array<{ path: string; branch: string | null }> = [];
    let cur: { path: string; branch: string | null } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice(9), branch: null };
        items.push(cur);
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
    }
    return items;
  }

  /** Makes sure the repo has a commit to branch from (fresh `agnt0 init` repos have none). */
  async ensureInitialCommit(): Promise<string> {
    const sha = await headSha(this.repoRoot);
    if (sha) return sha;
    await commitAll(this.repoRoot, "agnt0: initial commit", { allowEmpty: true });
    return (await headSha(this.repoRoot)) as string;
  }

  /**
   * Resolves the ref a new branch should start from. The server names it (the branch of the ticket
   * this one depends on) so dependent work starts with its dependency's commits instead of an empty
   * trunk. Falls back to HEAD when there is no base, when it is not a local branch yet, or when the
   * name does not survive sanitising — branching from the trunk is always safe, just emptier.
   */
  private async resolveBase(base: string | null | undefined): Promise<string> {
    if (!base) return "HEAD";
    const ref = safeRefPart(base);
    if (ref !== base) return "HEAD";
    return (await gitOk(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`])) ? ref : "HEAD";
  }

  async ensure(rel: string, branch: string | null, base: string | null = null): Promise<Worktree> {
    const path = this.resolvePath(rel);
    await ensureExcluded(this.repoRoot);
    const wantBranch = safeRefPart(branch ?? `agnt0/${basename(path)}`);

    if (existsSync(path)) {
      const real = await realpath(path);
      const known = await this.list();
      const match = await findAsync(known, async (w) => existsSync(w.path) && (await realpath(w.path)) === real);
      if (!match) throw new Error(`${rel} exists but is not a git worktree; remove it and run again.`);
      const baseSha = (await headSha(path)) as string;
      return { path, branch: match.branch ?? wantBranch, baseSha, created: false };
    }

    await this.ensureInitialCommit();
    await mkdir(dirname(path), { recursive: true });
    await git(this.repoRoot, ["worktree", "prune"]);
    const branchExists = await gitOk(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${wantBranch}`]);
    if (branchExists) await git(this.repoRoot, ["worktree", "add", "-q", path, wantBranch]);
    else await git(this.repoRoot, ["worktree", "add", "-q", "-b", wantBranch, path, await this.resolveBase(base)]);
    const baseSha = (await headSha(path)) as string;
    return { path, branch: wantBranch, baseSha, created: true };
  }
}

/**
 * Snapshot before a risky step: `refs/agnt0/checkpoints/<id>` points at a commit holding the current
 * working tree (tracked and untracked files, via a throwaway index; nothing is touched) or HEAD when
 * the tree is clean.
 */
export async function createCheckpoint(cwd: string, id: string): Promise<string | null> {
  if (!(await headSha(cwd))) return null;
  return (await createCheckpointRef(cwd, id))?.ref ?? null;
}

export interface DiffResult extends ShortStat {
  head_sha: string | null;
}

/**
 * Stages everything in a ticket worktree, measures it against the base commit (which also counts any
 * commits the agent made itself) and commits it so the ticket branch carries the work.
 */
export async function finalizeWorktree(path: string, baseSha: string, message: string): Promise<DiffResult> {
  await git(path, ["add", "-A"]);
  const stat = parseShortStat(await git(path, ["diff", "--cached", "--shortstat", baseSha]));
  await commitAll(path, message);
  return { ...stat, head_sha: await headSha(path) };
}

/** Repo-root steps (plans) are measured but never committed, so the user's own work is left alone. */
export async function measureRoot(root: string): Promise<DiffResult> {
  const head = await headSha(root);
  if (!head) return { files_changed: 0, lines_added: 0, lines_removed: 0, head_sha: null };
  const stat = parseShortStat(await git(root, ["diff", "--shortstat", "HEAD"]));
  return { ...stat, head_sha: head };
}

async function findAsync<T>(items: T[], pred: (t: T) => Promise<boolean>): Promise<T | undefined> {
  for (const i of items) if (await pred(i)) return i;
  return undefined;
}
