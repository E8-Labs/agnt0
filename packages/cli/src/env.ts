import { EnvPullResponse, m2routes, type EnvName } from "@agnt0/protocol";
import { chmod, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiClient } from "./api/client.js";
import { debug } from "./config.js";
import { ApiHttpError, CliError } from "./errors.js";
import { gitOk } from "./git.js";

export type EnvVars = Record<string, string>;

/**
 * Keys never handed to the runner (Claude Code / Codex) even when the project defines them: they would
 * switch the user's own runner login, billing or toolchain. Dev servers still get them.
 */
const RUNNER_HELD_BACK = /^(ANTHROPIC_|CLAUDE_|CODEX_|AGNT0_)|^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/;
/** Keys never injected anywhere: they'd break the child process itself. */
const PROCESS_RESERVED = /^(PATH|HOME|USER|SHELL|PWD|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES)$/;

/** GET /v1/projects/{id}/env. Returns null when the API has no env for this project (404). */
export async function pullEnv(api: ApiClient, projectId: string, environment: EnvName = "dev"): Promise<EnvVars | null> {
  try {
    const res = await api.get(`${m2routes.env(projectId)}?environment=${environment}`, { schema: EnvPullResponse, max429Retries: 0 });
    return res.vars;
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 404) return null;
    throw e;
  }
}

/** Best effort for `run` / `preview`: the dev environment, or {} on any problem. Never logs values. */
export async function loadDevEnv(api: ApiClient, projectId: string): Promise<EnvVars> {
  try {
    return (await pullEnv(api, projectId, "dev")) ?? {};
  } catch (e) {
    debug("env pull skipped", e instanceof Error ? e.message : e);
    return {};
  }
}

export function splitForRunner(vars: EnvVars): { env: EnvVars; heldBack: string[] } {
  const env: EnvVars = {};
  const heldBack: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (PROCESS_RESERVED.test(k) || RUNNER_HELD_BACK.test(k)) heldBack.push(k);
    else env[k] = v;
  }
  return { env, heldBack: heldBack.sort() };
}

export function forDevServer(vars: EnvVars): EnvVars {
  return Object.fromEntries(Object.entries(vars).filter(([k]) => !PROCESS_RESERVED.test(k)));
}

/** One dotenv line. Bare when safe, single quotes when possible (no expansion), else double quotes. */
export function dotenvLine(key: string, value: string): string {
  if (/^[A-Za-z0-9_./:@+,-]*$/.test(value)) return `${key}=${value}`;
  if (!/['\n\r]/.test(value)) return `${key}='${value}'`;
  const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\$/g, "\\$");
  return `${key}="${esc}"`;
}

/**
 * Merges `vars` into existing `.env.local` text: replaces lines for keys we manage, keeps every other
 * line and comment, appends new keys under a marker comment.
 */
export function mergeDotenv(existing: string, vars: EnvVars): string {
  const pending = new Map(Object.entries(vars));
  const lines = existing ? existing.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && pending.has(key)) {
      const v = pending.get(key) as string;
      pending.delete(key);
      return dotenvLine(key, v);
    }
    return line;
  });
  if (pending.size) {
    if (!lines.some((l) => l.startsWith("# Agent Zero"))) out.push(...(out.length ? [""] : []), "# Agent Zero project env (agnt0 env pull --write). Keep this file out of git.");
    for (const [k, v] of [...pending].sort(([a], [b]) => a.localeCompare(b))) out.push(dotenvLine(k, v));
  }
  return `${out.join("\n")}\n`;
}

export interface WriteEnvResult {
  path: string;
  gitignoreUpdated: boolean;
}

/** Writes `.env.local` (mode 0600) at the repo root and makes sure git ignores it. */
export async function writeEnvLocal(root: string, vars: EnvVars, file = ".env.local"): Promise<WriteEnvResult> {
  if (await gitOk(root, ["ls-files", "--error-unmatch", "--", file])) {
    throw new CliError(`${file} is tracked by git, so writing secrets into it would commit them.`, `Untrack it first: git rm --cached ${file}`);
  }
  const path = join(root, file);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* new file */
  }
  await writeFile(path, mergeDotenv(existing, vars), { mode: 0o600 });
  await chmod(path, 0o600);

  let gitignoreUpdated = false;
  if (!(await gitOk(root, ["check-ignore", "-q", "--", file]))) {
    const gi = join(root, ".gitignore");
    let cur = "";
    try {
      cur = await readFile(gi, "utf8");
    } catch {
      /* none yet */
    }
    const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
    await appendFile(gi, `${prefix}${file}\n`);
    gitignoreUpdated = true;
  }
  return { path, gitignoreUpdated };
}
