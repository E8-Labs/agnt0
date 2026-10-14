import { Project, ProjectList, routes } from "@agnt0/protocol";
import { execa } from "execa";
import pc from "picocolors";
import { mkdir, readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { ApiClient } from "../api/client.js";
import { type Context, requireLogin } from "../context.js";
import { debug } from "../config.js";
import { ApiHttpError, CliError } from "../errors.js";
import { pickProject, ttyPickerIO, type PickerIO } from "../picker.js";
import { ensureExcluded, headSha, isGitRepo, repoRoot } from "../git.js";
import { PROJECT_FILE, readProjectFile, writeProjectFile } from "../project.js";

export interface LinkParams {
  api: ApiClient;
  apiUrl: string;
  dir: string;
  mode: "new" | "existing";
  name?: string;
  brief?: string;
  force?: boolean;
  /** Attach to this existing project instead of creating one. */
  projectId?: string;
  /** Offer "use existing vs create new" when the account has projects (TTY only). */
  picker?: PickerIO | null;
}

export interface LinkResult {
  project: Project;
  root: string;
  projectFile: string;
  gitInitialized: boolean;
  attached: boolean;
}

/** GET /v1/projects/:id with friendly errors. */
export async function fetchProject(api: ApiClient, id: string): Promise<Project> {
  try {
    return await api.get(routes.project(encodeURIComponent(id)), { schema: Project });
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 404) {
      throw new CliError(`There's no project ${id} in your account.`, "Check the id on the dashboard, or run `agnt0 status` to see which account you're using.");
    }
    throw e;
  }
}

async function listProjects(api: ApiClient): Promise<Project[]> {
  try {
    return (await api.get(routes.projects, { schema: ProjectList })).projects;
  } catch (e) {
    debug("project list failed", e);
    return [];
  }
}

/** Shared by `init` (mode new) and `link` (mode existing). */
export async function createAndLinkProject(p: LinkParams): Promise<LinkResult> {
  // Verify an explicit --project before touching the filesystem.
  const requested = p.projectId ? await fetchProject(p.api, p.projectId) : null;
  let root = resolve(p.dir);
  let gitInitialized = false;
  if (p.mode === "new") {
    await mkdir(root, { recursive: true });
    if (!(await isGitRepo(root))) {
      const r = await execa("git", ["init", "-q"], { cwd: root, reject: false });
      if (r.exitCode !== 0) throw new CliError(`git init failed: ${r.stderr.trim()}`, "Is git installed? Run `agnt0 doctor`.");
      gitInitialized = true;
    } else {
      root = (await repoRoot(root)) ?? root;
    }
  } else {
    const top = await repoRoot(root);
    if (!top) throw new CliError("This folder isn't a git repository.", "`agnt0 link` works on an existing repo; use `agnt0 init` to start a new project.");
    root = top;
  }

  const existing = await readProjectFile(root);
  if (existing && !p.force) {
    throw new CliError(`This repo is already linked to project ${existing.project_id}.`, "Pass --force to replace the link.");
  }

  let project: Project | null = requested;
  if (!project && p.picker) {
    const existingProjects = await listProjects(p.api);
    if (existingProjects.length) {
      const pick = await pickProject(existingProjects, p.picker, { defaultNew: Boolean(p.name), verb: p.mode === "new" ? "Project" : "Link to" });
      if (pick.kind === "existing") project = pick.project;
    }
  }
  const attached = project !== null;
  if (attached && p.brief) {
    throw new CliError("--brief only applies when creating a new project.", "Edit the brief of an existing project in the dashboard (agnt0 open).");
  }

  if (!project) {
    const name = (p.name ?? basename(root)).trim().slice(0, 80) || "my-app";
    const repoSha = p.mode === "existing" ? await headSha(root) : null;
    project = await p.api.post(routes.projects, {
      body: {
        name,
        mode: p.mode,
        ...(p.brief ? { brief: p.brief } : {}),
        ...(repoSha ? { repo_sha: repoSha } : {}),
      },
      schema: Project,
    });
  }

  const projectFile = await writeProjectFile(root, { project_id: project.id, api_url: p.apiUrl, name: project.name });
  await ensureExcluded(root);
  return { project, root, projectFile, gitInitialized, attached };
}

async function readBrief(opts: { brief?: string; briefFile?: string }): Promise<string | undefined> {
  if (opts.brief && opts.briefFile) throw new CliError("Use either --brief or --brief-file, not both.");
  let brief = opts.brief;
  if (opts.briefFile) {
    try {
      brief = await readFile(resolve(opts.briefFile), "utf8");
    } catch {
      throw new CliError(`Can't read ${opts.briefFile}.`);
    }
  }
  if (brief && brief.length > 20000) throw new CliError("The brief is longer than 20,000 characters.", "Trim it, or add detail later in the dashboard.");
  return brief?.trim() || undefined;
}

export async function initCommand(
  ctx: Context,
  name: string | undefined,
  opts: { brief?: string; briefFile?: string; dir?: string; force?: boolean; project?: string },
  log: (l: string) => void = console.log,
  picker: PickerIO | null = defaultPicker(),
): Promise<LinkResult> {
  await requireLogin(ctx);
  const brief = await readBrief(opts);
  if (brief && opts.project) throw new CliError("--brief only applies when creating a new project.", "Edit the brief of an existing project in the dashboard (agnt0 open).");
  const res = await createAndLinkProject({
    api: ctx.api,
    apiUrl: ctx.apiUrl,
    dir: opts.dir ?? process.cwd(),
    mode: "new",
    name,
    brief,
    force: opts.force,
    projectId: opts.project,
    picker: brief ? null : picker,
  });
  printLinked(ctx, res, log);
  if (!brief && !res.attached) log(pc.dim(`  Tip: describe the app in the dashboard (agnt0 open) or re-run with --brief "…".`));
  return res;
}

export async function linkCommand(
  ctx: Context,
  name: string | undefined,
  opts: { force?: boolean; project?: string },
  log: (l: string) => void = console.log,
  picker: PickerIO | null = defaultPicker(),
): Promise<LinkResult> {
  await requireLogin(ctx);
  const res = await createAndLinkProject({ api: ctx.api, apiUrl: ctx.apiUrl, dir: process.cwd(), mode: "existing", name, force: opts.force, projectId: opts.project, picker });
  printLinked(ctx, res, log);
  return res;
}

/** The picker only runs in an interactive terminal; scripts and CI keep the old create-new behaviour. */
function defaultPicker(): PickerIO | null {
  return process.stdin.isTTY && process.stdout.isTTY ? ttyPickerIO() : null;
}

function printLinked(ctx: Context, res: LinkResult, log: (l: string) => void): void {
  if (res.gitInitialized) log(pc.dim(`  Initialized a git repository in ${res.root}`));
  log(`${pc.green("✓")} ${res.attached ? "Attached to" : "Created"} project ${pc.bold(res.project.name)} ${pc.dim(`(${res.project.id} · ${res.project.phase.replace("_", " ")})`)}`);
  log(pc.dim(`  Wrote ${relative(process.cwd(), resolve(res.root, PROJECT_FILE)) || PROJECT_FILE} (excluded from git)`));
  log(`  Next: ${pc.cyan("agnt0 run")} to start building · ${pc.cyan("agnt0 open")} for the dashboard ${pc.dim(`(${ctx.webUrl}/p/${res.project.id})`)}`);
}
