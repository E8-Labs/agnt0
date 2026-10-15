/**
 * Unpacks the skills a step was given, for whichever runner is about to run.
 *
 * The rules this file keeps:
 *  - Nothing is cloned at run time. A bundle arrives as a signed download with a checksum, and a
 *    mismatch means the skill is skipped, not used.
 *  - Skills never land in the user's repo or global settings. Claude loads them from a directory
 *    outside the repo; Codex only reads `.agents/skills/` inside the worktree, so that one is
 *    excluded from git and deleted when the step ends.
 *  - Agent Zero's own skills are deleted after every step. Open-source bundles stay cached, because
 *    their data files are large and their contents are public anyway.
 *
 * A skill that cannot be loaded is reported and skipped: a step is still worth running without it.
 *
 * Two layouts, because the two runners want different things:
 *  - `<home>/skills/cache/<slug>/<version>/` holds a reusable skill as the registry packed it.
 *  - `<home>/skills/step/<stepId>/agnt0/` is a Claude Code plugin directory holding this step's
 *    skills under `skills/<slug>/`, so they address as `agnt0:<slug>` and go away with the step.
 */
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Step, StepSkill } from "@agnt0/protocol";
import { agnt0Home } from "../config.js";
import { ensureExcluded } from "../git.js";

/** A skill is instructions and a few helpers; anything bigger is not a skill. */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_FILES = 60;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** The plugin all of a step's skills are loaded as, so they read `agnt0:<slug>` to the model. */
const PLUGIN_NAME = "agnt0";

export interface LoadedSkill {
  slug: string;
  version: string;
  /** True when it came from, or went into, the on-disk cache rather than this step's own directory. */
  cached: boolean;
}

export interface LoadedSkills {
  /** Passed to Claude Code as `--plugin-dir`. Empty for Codex, which reads its own from the worktree. */
  pluginDirs: string[];
  loaded: LoadedSkill[];
  /** Human-readable reasons a skill was skipped. Never fatal. */
  problems: string[];
  /** Removes everything this step created. Cached bundles are left alone. */
  cleanup: () => Promise<void>;
}

interface BundleFile {
  path: string;
  content: string;
  executable?: boolean;
}

export const EMPTY_SKILLS: LoadedSkills = { pluginDirs: [], loaded: [], problems: [], cleanup: async () => {} };

/** Where a cacheable skill version lives between steps, as the registry packed it. */
export function skillCacheDir(slug: string, version: string): string {
  return join(agnt0Home(), "skills", "cache", slug, safePart(version));
}

/** The plugin directory for one step, deleted when it ends. */
export function stepPluginDir(stepId: string): string {
  return join(agnt0Home(), "skills", "step", safePart(stepId), PLUGIN_NAME);
}

/** Keeps a version or step id from reaching outside its directory. */
function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "x";
}

function checkPath(p: string): boolean {
  if (!p || p.length > 200) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  if (p.includes("\\") || p.includes("\0")) return false;
  return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** Unpacks the bundle format the registry packs: gzipped JSON, so no archive library is needed. */
export function parseBundle(body: Buffer, expect: { slug: string }): BundleFile[] {
  const json = JSON.parse(gunzipSync(body).toString("utf8")) as { format?: string; slug?: string; files?: BundleFile[] };
  if (json.format !== "agnt0-skill-bundle/1") throw new Error(`unknown bundle format ${String(json.format)}`);
  if (json.slug !== expect.slug) throw new Error(`bundle is for ${String(json.slug)}, not ${expect.slug}`);
  const files = json.files ?? [];
  if (!files.length) throw new Error("bundle is empty");
  if (files.length > MAX_BUNDLE_FILES) throw new Error(`bundle holds ${files.length} files`);
  // Paths first: a bundle trying to write outside its folder should be reported as that, not as a
  // missing SKILL.md.
  for (const f of files) if (!checkPath(f.path)) throw new Error(`bundle path is not one we will write: ${f.path}`);
  if (!files.some((f) => f.path === "SKILL.md")) throw new Error("bundle has no SKILL.md");
  return files;
}

async function writeSkillDir(dir: string, files: BundleFile[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const f of files) {
    const target = join(dir, f.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, Buffer.from(f.content, "base64"));
    if (f.executable) await chmod(target, 0o755).catch(() => {});
  }
}

/** The manifest gives the plugin a stable name, instead of borrowing the directory's. */
async function writePluginManifest(pluginDir: string): Promise<void> {
  await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: PLUGIN_NAME, description: "Skills for this Agent Zero step", version: "1.0.0" }, null, 2)}\n`,
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed with ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_BUNDLE_BYTES) throw new Error(`bundle is ${Math.round(body.byteLength / 1024)} KB`);
  return body;
}

/**
 * The checksum came with the step, over exactly the bytes a download returns, and it is checked here
 * rather than inside the download — so swapping the transport can never skip it. A mismatch is not
 * something to retry.
 */
function verify(body: Buffer, sha256: string): Buffer {
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== sha256) throw new Error(`checksum did not match (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  return body;
}

export interface LoadOptions {
  /** The worktree the step runs in. Codex reads `.agents/skills/` from here. */
  cwd: string;
  /** The repo root, where `.git/info/exclude` lives. Defaults to `cwd`. */
  repoRoot?: string;
  /** Swapped out in tests. Whatever it returns is still checked against the step's checksum. */
  fetchBundle?: (url: string) => Promise<Buffer>;
}

export async function loadStepSkills(step: Step, opts: LoadOptions): Promise<LoadedSkills> {
  const skills = step.skills ?? [];
  if (!skills.length) return EMPTY_SKILLS;

  const get = opts.fetchBundle ?? download;
  const loaded: LoadedSkill[] = [];
  const problems: string[] = [];
  const inWorktree: string[] = [];
  const forCodex = step.runner === "codex";
  const pluginDir = stepPluginDir(step.step_id);
  let wrotePlugin = false;

  for (const skill of skills) {
    try {
      if (!SLUG_RE.test(skill.slug)) throw new Error("the name is not one we will write to disk");
      const { dir, cached } = await materialize(skill, step.step_id, get);
      if (forCodex) {
        // Codex finds skills at `.agents/skills/<name>` inside the directory it runs in, and nowhere
        // else we would rather use: `~/.codex/skills` is the user's own global settings.
        const target = join(opts.cwd, ".agents", "skills", skill.slug);
        await rm(target, { recursive: true, force: true });
        await mkdir(join(target, ".."), { recursive: true });
        await cp(dir, target, { recursive: true });
        inWorktree.push(target);
      } else {
        if (!wrotePlugin) {
          await rm(pluginDir, { recursive: true, force: true });
          await writePluginManifest(pluginDir);
          wrotePlugin = true;
        }
        const target = join(pluginDir, "skills", skill.slug);
        await mkdir(join(target, ".."), { recursive: true });
        await cp(dir, target, { recursive: true });
      }
      loaded.push({ slug: skill.slug, version: skill.version, cached });
    } catch (e) {
      problems.push(`${skill.slug}@${skill.version}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (inWorktree.length) {
    // Belt and braces: the directory is deleted after the step, and git never sees it in between.
    await ensureExcluded(opts.repoRoot ?? opts.cwd, ".agents/").catch(() => {});
  }

  const stepRoot = join(agnt0Home(), "skills", "step", safePart(step.step_id));
  return {
    pluginDirs: wrotePlugin && loaded.length ? [pluginDir] : [],
    loaded,
    problems,
    cleanup: async () => {
      for (const p of inWorktree) await rm(p, { recursive: true, force: true }).catch(() => {});
      await rm(stepRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Gets one skill's own files onto disk — SKILL.md at the root, as the registry packed it — reusing
 * the cache when the registry allows it.
 */
async function materialize(
  skill: StepSkill,
  stepId: string,
  get: (url: string) => Promise<Buffer>,
): Promise<{ dir: string; cached: boolean }> {
  const stepDir = join(agnt0Home(), "skills", "step", safePart(stepId), "unpacked", skill.slug);
  if ("inline" in skill) {
    // Instruction-only, and ours: it rides in the step and is deleted with it.
    await writeSkillDir(stepDir, [{ path: "SKILL.md", content: Buffer.from(skill.inline, "utf8").toString("base64") }]);
    return { dir: stepDir, cached: false };
  }
  const dir = skill.cache ? skillCacheDir(skill.slug, skill.version) : stepDir;
  if (skill.cache && (await fileExists(join(dir, "SKILL.md")))) return { dir, cached: true };
  const files = parseBundle(verify(await get(skill.url), skill.sha256), { slug: skill.slug });
  await writeSkillDir(dir, files);
  return { dir, cached: skill.cache };
}
