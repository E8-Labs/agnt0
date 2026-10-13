import { routes } from "@agnt0/protocol";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand, linkCommand } from "../src/commands/init.js";
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
    expect(out.text()).toContain("Project my-app (prj_1) linked");
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
