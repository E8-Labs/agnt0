import { m2routes, routes, type Checkpoint, type Step } from "@agnt0/protocol";
import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotWorkingTree } from "../src/checkpoint.js";
import { checkpointCommand, checkpointsCommand, rollbackCommand } from "../src/commands/checkpoint.js";
import { restoreRequestedLines } from "../src/commands/run.js";
import { writeProjectFile } from "../src/project.js";
import { runLoop } from "../src/run/loop.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "../src/runners/types.js";
import { initialWatchState, reduceWatch } from "../src/watch/state.js";
import { captureLog, makeCtx, startMockApi, tempDir, usageSnapshot, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();

const g = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout.trim();
const commit = (msg: string) => g("-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-am", msg);

function record(body: any, id = "ckp_1"): Checkpoint {
  return { id, project_id: "prj_1", name: body.name, git_sha: body.git_sha, git_ref: body.git_ref, created_by: body.created_by, step_id: body.step_id ?? null, created_at: new Date().toISOString() };
}

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  await execa("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "app.js"), "v1\n");
  await g("add", "-A");
  await commit("one");
  await writeProjectFile(dir, { project_id: "prj_1", api_url: api.url, name: "demo" });
  await execa("git", ["update-index", "--refresh"], { cwd: dir, reject: false });
  await writeFile(join(dir, ".git", "info", "exclude"), ".agnt0/\n");
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  await api.close();
  await cleanup();
});

describe("snapshotWorkingTree", () => {
  it("captures modified and untracked files without touching the index or the files", async () => {
    await writeFile(join(dir, "app.js"), "v2-uncommitted\n");
    await writeFile(join(dir, "new.txt"), "untracked\n");
    const before = await g("status", "--porcelain");
    const sha = (await snapshotWorkingTree(dir, "test"))!;
    expect(await g("status", "--porcelain")).toBe(before);
    expect(await g("show", `${sha}:app.js`)).toBe("v2-uncommitted");
    expect(await g("show", `${sha}:new.txt`)).toBe("untracked");
    expect(await g("rev-parse", `${sha}^`)).toBe(await g("rev-parse", "HEAD"));
  });

  it("returns HEAD for a clean tree", async () => {
    expect(await snapshotWorkingTree(dir, "x")).toBe(await g("rev-parse", "HEAD"));
  });
});

describe("agnt0 checkpoint / checkpoints", () => {
  it("creates the ref and records it on the server", async () => {
    api.on("POST", m2routes.checkpoints("prj_1"), (r) => ({ status: 201, body: record(r.body) }));
    await writeFile(join(dir, "wip.txt"), "wip\n");
    const out = captureLog();
    await checkpointCommand(makeCtx(api.url), "before redesign", out.log);
    const post = api.requests.find((r) => r.path === m2routes.checkpoints("prj_1"))!;
    expect(post.body).toMatchObject({ name: "before redesign", created_by: "user" });
    expect(post.body.git_ref).toMatch(/^refs\/agnt0\/checkpoints\/user\/\d{8}-\d{6}-before-redesign$/);
    expect(await g("rev-parse", post.body.git_ref)).toBe(post.body.git_sha);
    expect(await g("show", `${post.body.git_sha}:wip.txt`)).toBe("wip");
    expect(out.text()).toContain("agnt0 rollback ckp_1");
  });

  it("still keeps the local checkpoint when the API can't record it", async () => {
    const out = captureLog();
    const res = await checkpointCommand(makeCtx(api.url), undefined, out.log);
    expect("ref" in res && res.ref).toMatch(/^refs\/agnt0\/checkpoints\/user\//);
    expect(out.text()).toContain("Couldn't record it");
  });

  it("lists server checkpoints and marks ones missing locally", async () => {
    const head = await g("rev-parse", "HEAD");
    api.on("GET", m2routes.checkpoints("prj_1"), () => ({
      body: {
        checkpoints: [
          record({ name: "Before Frontend Developer build", git_sha: head, git_ref: "refs/agnt0/checkpoints/stp_1", created_by: "agent", step_id: "stp_1" }, "ckp_a"),
          record({ name: "elsewhere", git_sha: "a".repeat(40), git_ref: "refs/agnt0/checkpoints/x", created_by: "user" }, "ckp_b"),
        ],
      },
    }));
    const out = captureLog();
    const list = await checkpointsCommand(makeCtx(api.url), {}, out.log);
    expect(list).toHaveLength(2);
    expect(out.text()).toContain("ckp_a");
    expect(out.text()).toMatch(/ckp_b.*not in this repo/);
  });
});

describe("agnt0 rollback", () => {
  async function scenario() {
    // checkpoint at v1 + an uncommitted file
    await writeFile(join(dir, "draft.txt"), "draft at checkpoint\n");
    const cpSha = (await snapshotWorkingTree(dir, "cp"))!;
    await g("update-ref", "refs/agnt0/checkpoints/user/cp1", cpSha);
    // later work: committed change, a new tracked file, uncommitted edits and an untracked file
    await execa("rm", ["draft.txt"], { cwd: dir });
    await writeFile(join(dir, "app.js"), "v2\n");
    await writeFile(join(dir, "later.js"), "later\n");
    await g("add", "-A");
    await commit("two");
    await writeFile(join(dir, "app.js"), "v3-uncommitted\n");
    await writeFile(join(dir, "scratch.txt"), "untracked notes\n");
    api.on("GET", m2routes.checkpoints("prj_1"), () => ({ body: { checkpoints: [record({ name: "cp one", git_sha: cpSha, git_ref: "refs/agnt0/checkpoints/user/cp1", created_by: "user" }, "ckp_1")] } }));
    api.on("POST", m2routes.checkpoints("prj_1"), (r) => ({ status: 201, body: record(r.body, "ckp_safety") }));
    return { cpSha, mainBefore: await g("rev-parse", "main") };
  }

  it("restores on a new branch after a safety checkpoint, leaving the old branch and untracked files alone", async () => {
    const { mainBefore } = await scenario();
    const out = captureLog();
    const res = (await rollbackCommand(makeCtx(api.url), "ckp_1", { yes: true }, out.log, null))!;

    expect(res.branch).toMatch(/^agnt0\/rollback-\d{8}-\d{6}$/);
    expect(await g("rev-parse", "--abbrev-ref", "HEAD")).toBe(res.branch);
    expect(await readFile(join(dir, "app.js"), "utf8")).toBe("v1\n");
    expect(await readFile(join(dir, "draft.txt"), "utf8")).toBe("draft at checkpoint\n");
    expect(await g("ls-files")).not.toContain("later.js");
    // untracked file untouched, original branch untouched, nothing else staged
    expect(await readFile(join(dir, "scratch.txt"), "utf8")).toBe("untracked notes\n");
    expect(await g("rev-parse", "main")).toBe(mainBefore);
    expect(await g("status", "--porcelain")).toBe("?? scratch.txt");

    // the safety checkpoint holds everything as it was, including uncommitted and untracked files
    expect(res.safety).not.toBeNull();
    expect(await g("show", `${res.safety!.sha}:app.js`)).toBe("v3-uncommitted");
    expect(await g("show", `${res.safety!.sha}:scratch.txt`)).toBe("untracked notes");
    const safetyPost = api.requests.find((r) => r.method === "POST" && r.path === m2routes.checkpoints("prj_1"))!;
    expect(safetyPost.body).toMatchObject({ name: "Before rollback to cp one", created_by: "user", git_sha: res.safety!.sha });
    expect(out.text()).toContain("git switch main");
  });

  it("asks first in a terminal and needs --yes otherwise", async () => {
    await scenario();
    await expect(rollbackCommand(makeCtx(api.url), "ckp_1", {}, () => {}, null)).rejects.toThrow(/needs confirmation/);
    const out = captureLog();
    const res = await rollbackCommand(makeCtx(api.url), "ckp_1", {}, out.log, async () => "n");
    expect(res).toBeNull();
    expect(out.text()).toContain("Cancelled");
    expect(await g("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("falls back to a local checkpoint ref when the id isn't on the server", async () => {
    await scenario();
    api.on("GET", m2routes.checkpoints("prj_1"), () => ({ body: { checkpoints: [] } }));
    const res = (await rollbackCommand(makeCtx(api.url), "user/cp1", { yes: true }, () => {}, null))!;
    expect(await readFile(join(dir, "app.js"), "utf8")).toBe("v1\n");
    expect(res.previousBranch).toBe("main");
    await expect(rollbackCommand(makeCtx(api.url), "nope", { yes: true }, () => {}, null)).rejects.toThrow(/no checkpoint nope/);
  });
});

describe("checkpoints in run", () => {
  it("records the per-step checkpoint as created_by agent with the step id", async () => {
    const step: Step = {
      step_id: "stp_7",
      project_id: "prj_1",
      ticket_id: "tkt_1",
      kind: "build",
      role: "frontend_developer",
      runner: "claude",
      model: "sonnet",
      prompt: "p",
      output_schema: null,
      compression: { read: [], write: "full" },
      allowed_tools: ["read"],
      scope: [],
      worktree: ".agnt0/wt/tkt_1",
      branch: "agnt0/tkt_1",
      approval: { requires_approval: [] },
      checkpoint_before: true,
      lease_expires_at: "2026-10-13T13:00:00Z",
      max_turns: 5,
      skills: [],
    };
    const steps = [{ kind: "step", step }, { kind: "idle", reason: "no_ready_tickets", message: "none" }];
    api.on("POST", routes.heartbeat, () => ({ status: 204 }));
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: steps.shift() }));
    api.on("POST", routes.stepComplete("stp_7"), () => ({ body: { credits_charged: 1, next: "continue", usage: usageSnapshot() } }));
    api.on("POST", m2routes.checkpoints("prj_1"), (r) => ({ status: 201, body: record(r.body) }));
    const usage = { runner: "claude" as const, model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, raw_tool_tokens: 0, sent_tool_tokens: 0 };
    const runner: RunnerAdapter = { id: "claude", label: "f", isAvailable: async () => true, run: async (_i: RunnerInput): Promise<RunnerResult> => ({ ok: true, finalText: "ok", usage }) };
    await mkdir(join(dir, ".agnt0"), { recursive: true });
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {}, sleep: async () => {} });
    const post = api.requests.find((r) => r.path === m2routes.checkpoints("prj_1"))!;
    expect(post.body).toMatchObject({ created_by: "agent", step_id: "stp_7", git_ref: "refs/agnt0/checkpoints/stp_7" });
    expect(post.body.git_sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("restore requests from the dashboard", () => {
  const ev = {
    type: "checkpoint.restore_requested" as const,
    checkpoint: { id: "ckp_9", project_id: "prj_1", name: "Before Backend Developer build", git_sha: "b".repeat(40), git_ref: "refs/agnt0/checkpoints/stp_9", created_by: "agent" as const, step_id: "stp_9", created_at: "2026-10-13T10:00:00Z" },
    requested_at: "2026-10-13T11:00:00Z",
  };
  it("prints the command for run --watch (never runs it)", () => {
    const text = restoreRequestedLines(ev).join("\n");
    expect(text).toContain("agnt0 rollback ckp_9");
  });
  it("shows a banner in watch", () => {
    const s = reduceWatch(initialWatchState, ev);
    expect(s.restore?.checkpoint.id).toBe("ckp_9");
    expect(s.feed[0]?.text).toContain("agnt0 rollback ckp_9");
  });
});
