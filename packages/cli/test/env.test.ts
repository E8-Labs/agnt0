import { m2routes, routes, type Step } from "@agnt0/protocol";
import { execa } from "execa";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envPullCommand } from "../src/commands/env.js";
import { dotenvLine, mergeDotenv, splitForRunner, writeEnvLocal } from "../src/env.js";
import { writeProjectFile } from "../src/project.js";
import { runLoop } from "../src/run/loop.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "../src/runners/types.js";
import { captureLog, makeCtx, makeRepo, startMockApi, tempDir, usageSnapshot, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();
const SECRET = "sk_live_super_secret_value_123";

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  await makeRepo(dir);
  await writeProjectFile(dir, { project_id: "prj_1", api_url: api.url, name: "demo" });
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(cwd);
  await api.close();
  await cleanup();
});

describe("dotenv formatting", () => {
  it("quotes only when needed and survives newlines, quotes and dollars", () => {
    expect(dotenvLine("A", "plain_value-1.2")).toBe("A=plain_value-1.2");
    expect(dotenvLine("B", "has space $HOME")).toBe("B='has space $HOME'");
    expect(dotenvLine("C", "it's\nmulti")).toBe('C="it\'s\\nmulti"');
  });
  it("merges into an existing file, keeping other lines", () => {
    const out = mergeDotenv("# mine\nKEEP=1\nAPI_KEY=old\n", { API_KEY: "new", ADDED: "x" });
    expect(out).toContain("# mine\nKEEP=1\nAPI_KEY=new\n");
    expect(out).toMatch(/# Agent Zero.*\nADDED=x\n$/);
  });
});

describe("writeEnvLocal", () => {
  it("writes mode 0600 and gitignores the file once", async () => {
    const res = await writeEnvLocal(dir, { STRIPE_KEY: SECRET });
    expect(res.gitignoreUpdated).toBe(true);
    expect((await stat(res.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(res.path, "utf8")).toContain(`STRIPE_KEY=${SECRET}`);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(".env.local\n");
    expect((await execa("git", ["check-ignore", "-q", ".env.local"], { cwd: dir, reject: false })).exitCode).toBe(0);

    const again = await writeEnvLocal(dir, { STRIPE_KEY: "rotated" });
    expect(again.gitignoreUpdated).toBe(false);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(".env.local\n");
    expect(await readFile(res.path, "utf8")).toContain("STRIPE_KEY=rotated");
  });

  it("tightens permissions of an existing file and respects an existing ignore rule", async () => {
    await writeFile(join(dir, ".gitignore"), ".env*\n");
    await writeFile(join(dir, ".env.local"), "OTHER=1\n", { mode: 0o644 });
    const res = await writeEnvLocal(dir, { K: "v" });
    expect(res.gitignoreUpdated).toBe(false);
    expect((await stat(res.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(res.path, "utf8")).toContain("OTHER=1");
  });

  it("refuses when .env.local is tracked by git", async () => {
    await writeFile(join(dir, ".env.local"), "X=1\n");
    await execa("git", ["add", "-f", ".env.local"], { cwd: dir });
    await expect(writeEnvLocal(dir, { K: "v" })).rejects.toThrow(/tracked by git/);
  });
});

describe("agnt0 env pull", () => {
  it("prints the count and keys, never the values", async () => {
    api.on("GET", m2routes.env("prj_1"), (r) => ({ body: { environment: r.query.get("environment"), vars: { STRIPE_KEY: SECRET, DATABASE_URL: "postgres://u:p@h/db" } } }));
    const out = captureLog();
    const res = await envPullCommand(makeCtx(api.url), {}, [], out.log);
    expect(Object.keys(res.vars)).toHaveLength(2);
    expect(out.text()).toContain("2 dev env vars");
    expect(out.text()).toContain("DATABASE_URL, STRIPE_KEY");
    expect(out.text()).not.toContain(SECRET);
    expect(out.text()).not.toContain("postgres://");
    expect(api.requests[0]!.query.get("environment")).toBe("dev");
  });

  it("--write writes .env.local; --environment picks the set", async () => {
    api.on("GET", m2routes.env("prj_1"), (r) => ({ body: { environment: r.query.get("environment"), vars: { STRIPE_KEY: SECRET } } }));
    const out = captureLog();
    const res = await envPullCommand(makeCtx(api.url), { write: true, environment: "preview" }, [], out.log);
    expect(api.requests[0]!.query.get("environment")).toBe("preview");
    expect(res.written).toBe(join(dir, ".env.local"));
    expect(out.text()).not.toContain(SECRET);
    expect(out.text()).toContain("added it to .gitignore");
  });

  it("handles a project without env (404) and rejects unknown environments", async () => {
    const out = captureLog();
    const res = await envPullCommand(makeCtx(api.url), {}, [], out.log);
    expect(res.vars).toEqual({});
    expect(out.text()).toContain("No dev env vars");
    await expect(envPullCommand(makeCtx(api.url), { environment: "staging" }, [], () => {})).rejects.toThrow(/Unknown environment/);
  });

  it("runs a command with the vars injected", async () => {
    api.on("GET", m2routes.env("prj_1"), () => ({ body: { environment: "dev", vars: { GREETING: "hello" } } }));
    const res = await envPullCommand(makeCtx(api.url), {}, [process.execPath, "-e", "process.exit(process.env.GREETING === 'hello' ? 0 : 3)"], () => {});
    expect(res.exitCode).toBe(0);
    process.exitCode = 0;
  });
});

describe("env in run", () => {
  it("keeps runner-login keys away from the runner", () => {
    const { env, heldBack } = splitForRunner({ STRIPE_KEY: "a", ANTHROPIC_API_KEY: "b", OPENAI_API_KEY: "c", PATH: "/x" });
    expect(env).toEqual({ STRIPE_KEY: "a" });
    expect(heldBack).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PATH"]);
  });

  it("passes the project env to the runner process", async () => {
    const step: Step = {
      step_id: "stp_1", project_id: "prj_1", ticket_id: null, kind: "plan", role: "planner", runner: "claude", model: "opus", prompt: "p",
      output_schema: null, compression: { read: [], write: "full" }, allowed_tools: ["read"], scope: [], worktree: null, branch: null,
      approval: { requires_approval: [] }, checkpoint_before: false, lease_expires_at: "2026-10-13T13:00:00Z", max_turns: 5, skills: [],
    };
    const steps = [{ kind: "step", step }];
    api.on("POST", routes.heartbeat, () => ({ status: 204 }));
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: steps.shift() }));
    api.on("POST", routes.stepComplete("stp_1"), () => ({ body: { credits_charged: 1, next: "continue", usage: usageSnapshot() } }));
    const inputs: RunnerInput[] = [];
    const usage = { runner: "claude" as const, model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, raw_tool_tokens: 0, sent_tool_tokens: 0 };
    const runner: RunnerAdapter = { id: "claude", label: "f", isAvailable: async () => true, run: async (i): Promise<RunnerResult> => (inputs.push(i), { ok: true, finalText: "ok", usage }) };
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {}, maxSteps: 1, env: { STRIPE_KEY: "a" } });
    expect(inputs[0]!.env).toEqual({ STRIPE_KEY: "a" });
  });
});
