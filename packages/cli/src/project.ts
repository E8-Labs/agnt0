import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CliError } from "./errors.js";

export const ProjectFile = z.object({
  project_id: z.string(),
  api_url: z.string(),
  name: z.string().optional(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

export const PROJECT_FILE = join(".agnt0", "project.json");

export interface LinkedProject extends ProjectFile {
  /** Directory that contains `.agnt0/project.json`. */
  root: string;
}

export async function readProjectFile(root: string): Promise<ProjectFile | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, PROJECT_FILE), "utf8"));
    const p = ProjectFile.safeParse(raw);
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export async function writeProjectFile(root: string, data: ProjectFile): Promise<string> {
  const path = join(root, PROJECT_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

/**
 * Walks up from `cwd` to find `.agnt0/project.json`. Worktrees live inside `.agnt0/wt/`, so running
 * from a worktree still finds the main project.
 */
export async function findProject(cwd = process.cwd()): Promise<LinkedProject | null> {
  let dir = resolve(cwd);
  for (;;) {
    const p = await readProjectFile(dir);
    if (p) return { ...p, root: dir };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function requireProject(cwd = process.cwd()): Promise<LinkedProject> {
  const p = await findProject(cwd);
  if (!p) throw new CliError("This folder isn't linked to an Agent Zero project.", "Run `agnt0 init` for a new project or `agnt0 link` for an existing repo.");
  return p;
}
