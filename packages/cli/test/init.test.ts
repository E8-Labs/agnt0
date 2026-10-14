import { routes } from "@agnt0/protocol";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand, linkCommand } from "../src/commands/init.js";
import type { PickerIO } from "../src/picker.js";
import { captureLog, makeCtx, makeRepo, startMockApi, tempDir, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();

const project = (over: Record<string, unknown> = {}) => ({
  id: "prj_1",
  name: "my-app",
  phase: "define",
  brief: null,
  repo_sha: null,
  settings: { default_runner: "claude", runner_by_role: {}, approval_policy: "ask_risky" },
  created_at: "2026-10-13T00:00:00Z",
  ...over,
});

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  process.chdir(cwd);
  await api.close();
  await cleanup();
});

describe("agnt0 init", () => {
  it("creates the project, writes .agnt0/project.json and excludes .agnt0/ from git", async () => {
    api.on("POST", routes.projects, (r) => ({ status: 201, body: project({ name: r.body.name, brief: r.body.brief ?? null }) }));
    const ctx = makeCtx(api.url);
    const out = captureLog();
    const target = join(dir, "my-app");
    const res = await initCommand(ctx, "my-app", { brief: "A habit tracker", dir: target }, out.log);

    expect(api.requests[0]!.body).toEqual({ name: "my-app", mode: "new", brief: "A habit tracker" });
    expect(api.requests[0]!.headers.authorization).toBe("Bearer at_1");
    expect(res.gitInitialized).toBe(true);
    const pf = JSON.parse(await readFile(join(target, ".agnt0", "project.json"), "utf8"));
    expect(pf).toEqual({ project_id: "prj_1", api_url: api.url, name: "my-app" });
    const exclude = await readFile(join(target, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n")).toContain(".agnt0/");
    expect((await execa("git", ["status", "--porcelain"], { cwd: target })).stdout).toBe("");
    expect(out.text()).toContain("Created project my-app (prj_1 · define)");
  });

  it("reads the brief from a file and refuses to relink without --force", async () => {
    api.on("POST", routes.projects, () => ({ body: project() }));
    const ctx = makeCtx(api.url);
    await writeFile(join(dir, "brief.md"), "Build a todo app\n");
    await initCommand(ctx, undefined, { briefFile: join(dir, "brief.md"), dir }, () => {});
    expect(api.requests[0]!.body.brief).toBe("Build a todo app");
    await expect(initCommand(ctx, undefined, { dir }, () => {})).rejects.toThrow(/already linked/);
    await initCommand(ctx, undefined, { dir, force: true }, () => {});
    // a second exclude line is not added
    const exclude = await readFile(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/^\.agnt0\/$/gm)).toHaveLength(1);
  });

  it("needs a login", async () => {
    const ctx = makeCtx(api.url, null);
    await expect(initCommand(ctx, "x", { dir }, () => {})).rejects.toThrow(/not logged in/);
    expect(existsSync(join(dir, ".agnt0"))).toBe(false);
  });
});

describe("agnt0 link", () => {
  it("links an existing repo with mode existing and the HEAD sha", async () => {
    await makeRepo(dir);
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    api.on("POST", routes.projects, (r) => ({ body: project({ name: r.body.name, repo_sha: r.body.repo_sha }) }));
    process.chdir(dir);
    await linkCommand(makeCtx(api.url), "legacy", {}, () => {});
    expect(api.requests[0]!.body).toEqual({ name: "legacy", mode: "existing", repo_sha: head });
    expect(existsSync(join(dir, ".agnt0", "project.json"))).toBe(true);
  });

  it("refuses folders that aren't git repos", async () => {
    process.chdir(dir);
    await expect(linkCommand(makeCtx(api.url), undefined, {}, () => {})).rejects.toThrow(/isn't a git repository/);
  });
});

function scriptedPicker(answers: string[]): PickerIO & { prompts: string[]; out: string[] } {
  const prompts: string[] = [];
  const out: string[] = [];
  return { prompts, out, log: (l) => out.push(l), ask: async (q) => (prompts.push(q), answers.shift() ?? "") };
}

describe("attaching to an existing project", () => {
  it("init --project verifies the project and links without creating one", async () => {
    api.on("GET", routes.project("prj_guide"), () => ({ body: project({ id: "prj_guide", name: "guide-app", phase: "wireframe" }) }));
    const out = captureLog();
    const res = await initCommand(makeCtx(api.url), undefined, { dir, project: "prj_guide" }, out.log, null);
    expect(res.attached).toBe(true);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${routes.project("prj_guide")}`]);
    expect(JSON.parse(await readFile(join(dir, ".agnt0", "project.json"), "utf8"))).toEqual({ project_id: "prj_guide", api_url: api.url, name: "guide-app" });
    expect(await readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".agnt0/");
    expect(out.text()).toContain("Attached to project guide-app (prj_guide · wireframe)");
  });

  it("init --project with an unknown id fails before touching the folder", async () => {
    const target = join(dir, "nope");
    await expect(initCommand(makeCtx(api.url), undefined, { dir: target, project: "prj_missing" }, () => {}, null)).rejects.toThrow(/no project prj_missing/);
    expect(existsSync(target)).toBe(false);
  });

  it("init --project refuses --brief", async () => {
    await expect(initCommand(makeCtx(api.url), undefined, { dir, project: "prj_x", brief: "hi" }, () => {}, null)).rejects.toThrow(/only applies when creating/);
  });

  it("link --project links the current repo to an existing project", async () => {
    await makeRepo(dir);
    api.on("GET", routes.project("prj_guide"), () => ({ body: project({ id: "prj_guide", name: "guide-app" }) }));
    process.chdir(dir);
    const res = await linkCommand(makeCtx(api.url), undefined, { project: "prj_guide" }, () => {}, null);
    expect(res.attached).toBe(true);
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);
    expect(existsSync(join(dir, ".agnt0", "project.json"))).toBe(true);
  });

  it("the picker offers existing projects and attaches to the chosen one", async () => {
    api.on("GET", routes.projects, () => ({ body: { projects: [project({ id: "prj_new", name: "newest" }), project({ id: "prj_old", name: "older" })] } }));
    const picker = scriptedPicker(["2"]);
    const res = await initCommand(makeCtx(api.url), undefined, { dir }, () => {}, picker);
    expect(res.project.id).toBe("prj_old");
    expect(picker.out.join("\n")).toContain("Create a new project");
    expect(picker.prompts[0]).toContain("[1]");
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("Enter picks the newest project, unless a name was given (then it defaults to new)", async () => {
    api.on("GET", routes.projects, () => ({ body: { projects: [project({ id: "prj_new", name: "newest" })] } }));
    api.on("POST", routes.projects, (r) => ({ status: 201, body: project({ id: "prj_created", name: r.body.name }) }));
    const res1 = await initCommand(makeCtx(api.url), undefined, { dir: join(dir, "a") }, () => {}, scriptedPicker([""]));
    expect(res1.project.id).toBe("prj_new");
    const p2 = scriptedPicker([""]);
    const res2 = await initCommand(makeCtx(api.url), "fresh", { dir: join(dir, "b") }, () => {}, p2);
    expect(p2.prompts[0]).toContain("[n]");
    expect(res2.project.id).toBe("prj_created");
    expect(api.requests.find((r) => r.method === "POST")!.body).toMatchObject({ name: "fresh", mode: "new" });
  });

  it("choosing n creates a new project; no picker (non-TTY) skips the list entirely", async () => {
    api.on("GET", routes.projects, () => ({ body: { projects: [project({ id: "prj_new" })] } }));
    api.on("POST", routes.projects, () => ({ status: 201, body: project({ id: "prj_created" }) }));
    expect((await initCommand(makeCtx(api.url), undefined, { dir: join(dir, "a") }, () => {}, scriptedPicker(["n"]))).project.id).toBe("prj_created");
    api.requests.length = 0;
    expect((await initCommand(makeCtx(api.url), undefined, { dir: join(dir, "b") }, () => {}, null)).project.id).toBe("prj_created");
    expect(api.requests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("an empty account skips the picker", async () => {
    api.on("GET", routes.projects, () => ({ body: { projects: [] } }));
    api.on("POST", routes.projects, () => ({ status: 201, body: project() }));
    const picker = scriptedPicker([]);
    await initCommand(makeCtx(api.url), undefined, { dir }, () => {}, picker);
    expect(picker.prompts).toHaveLength(0);
  });
});
