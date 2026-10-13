import { execa } from "execa";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const r = await execa("git", args, { cwd, reject: false });
  return r.exitCode === 0;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return gitOk(cwd, ["rev-parse", "--git-dir"]);
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await execa("git", ["rev-parse", "--show-toplevel"], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** HEAD sha, or null for a repo without commits / not a repo. */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await execa("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** `-c user.name/-c user.email` when the user has no identity configured, so agnt0 commits never fail. */
export async function identityArgs(cwd: string): Promise<string[]> {
  const email = await execa("git", ["config", "user.email"], { cwd, reject: false });
  const name = await execa("git", ["config", "user.name"], { cwd, reject: false });
  const args: string[] = [];
  if (name.exitCode !== 0 || !name.stdout.trim()) args.push("-c", "user.name=agnt0");
  if (email.exitCode !== 0 || !email.stdout.trim()) args.push("-c", "user.email=agnt0@users.noreply.agnt0.dev");
  return args;
}

export async function commitAll(cwd: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<boolean> {
  await git(cwd, ["add", "-A"]);
  const hasStaged = !(await gitOk(cwd, ["diff", "--cached", "--quiet"]));
  if (!hasStaged && !opts.allowEmpty) return false;
  const id = await identityArgs(cwd);
  await git(cwd, [...id, "commit", "-q", "--no-verify", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", message]);
  return true;
}

export interface ShortStat {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
}

export function parseShortStat(s: string): ShortStat {
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return {
    files_changed: n(/(\d+) files? changed/),
    lines_added: n(/(\d+) insertions?\(\+\)/),
    lines_removed: n(/(\d+) deletions?\(-\)/),
  };
}

/** Adds `.agnt0/` to the repo's info/exclude (shared by all worktrees) if missing. */
export async function ensureExcluded(cwd: string, pattern = ".agnt0/"): Promise<void> {
  let p = await git(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (!isAbsolute(p)) p = join(cwd, p);
  let current = "";
  try {
    current = await readFile(p, "utf8");
  } catch {
    await mkdir(dirname(p), { recursive: true });
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === pattern || l.trim() === pattern.replace(/\/$/, ""))) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(p, `${prefix}# Agent Zero local state\n${pattern}\n`);
}
