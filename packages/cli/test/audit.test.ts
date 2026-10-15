import { m2routes, m2routesApi, routes, type AuditOutput, type AuditRun, type Step } from "@agnt0/protocol";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditCommand } from "../src/commands/audit.js";
import { linkCommand } from "../src/commands/init.js";
import { writeProjectFile } from "../src/project.js";
import { runLoop } from "../src/run/loop.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "../src/runners/types.js";
import { captureLog, makeCtx, makeRepo, startMockApi, tempDir, usageSnapshot, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  await makeRepo(dir);
  api.on("POST", routes.heartbeat, () => ({ status: 204 }));
});
afterEach(async () => {
  process.chdir(cwd);
  await api.close();
  await cleanup();
});

const usage = { runner: "claude" as const, model: "m", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, raw_tool_tokens: 0, sent_tool_tokens: 0 };

const auditStep: Step = {
  step_id: "stp_audit",
  project_id: "prj_1",
  ticket_id: null,
  kind: "audit",
  role: "code_auditor",
  runner: "claude",
  model: "opus",
  prompt: "audit the repo",
  output_schema: "audit",
  compression: { read: ["logs"], write: "full" },
  allowed_tools: ["read", "bash:npm run *"],
  scope: ["**/*"],
  // even if a server ever sends a worktree / checkpoint for an audit, the CLI stays read-only in the root
  worktree: ".agnt0/wt/audit",
  branch: "agnt0/audit",
  approval: { requires_approval: ["install", "delete", "push", "network"] },
  checkpoint_before: true,
  lease_expires_at: "2026-10-13T13:00:00Z",
  max_turns: 120,
  skills: [],
};

const report: AuditOutput = {
  summary: "Half-wired checkout: two price calculations disagree.",
  score: { overall: 62, areas: { wiring: 50, tests: 70 } },
  findings: [
    { kind: "dead_code", severity: "low", title: "Unused util", file: "src/a.ts", line: 3, evidence: "never imported", confirmed_by_run: false },
    { kind: "dead_code", severity: "medium", title: "Unused route", file: "src/b.ts", line: 9, evidence: "never reached", confirmed_by_run: true },
    { kind: "unwired_call", severity: "high", title: "POST /api/cart has no handler", file: "src/cart.ts", line: 40, evidence: "404 in trace", confirmed_by_run: true },
    { kind: "contradiction", severity: "high", title: "Two price calculations", file: null, line: null, evidence: "diff 3%", confirmed_by_run: false },
  ],
};

function auditRun(over: Partial<AuditRun> = {}): AuditRun {
  return { id: "aud_1", project_id: "prj_1", trigger: "manual", mode: "full", status: "queued", score: null, areas: null, summary: null, estimate_credits: 40, credits_used: 0, commit_sha: null, created_at: new Date().toISOString(), completed_at: null, ...over };
}

describe("audit steps in run", () => {
  it("run in the repo root, read-only: no worktree, no checkpoint, no commit; prints a summary", async () => {
    const steps = [{ kind: "step", step: auditStep }];
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: steps.shift() }));
    api.on("POST", routes.stepComplete("stp_audit"), () => ({ body: { credits_charged: 40, next: "continue", usage: usageSnapshot() } }));
    const inputs: RunnerInput[] = [];
    const runner: RunnerAdapter = {
      id: "claude",
      label: "f",
      isAvailable: async () => true,
      run: async (i): Promise<RunnerResult> => (inputs.push(i), { ok: true, finalText: "Audit done.\n```json\n" + JSON.stringify(report) + "\n```", usage }),
    };
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout;
    const out = captureLog();
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "http://web.test", runners: [runner], log: out.log, maxSteps: 1 });

    expect(inputs[0]!.cwd).toBe(dir);
    expect(existsSync(join(dir, ".agnt0", "wt", "audit"))).toBe(false);
    expect((await execa("git", ["for-each-ref", "refs/agnt0/"], { cwd: dir })).stdout).toBe("");
    expect((await execa("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout).toBe(head);
    expect(api.requests.some((r) => r.path === m2routes.checkpoints("prj_1"))).toBe(false);

    const complete = api.requests.find((r) => r.path === routes.stepComplete("stp_audit"))!;
    expect(complete.body.outcome).toBe("succeeded");
    expect(complete.body.output).toEqual(report);
    expect(complete.body.diff).toBeUndefined();

    const text = out.text();
    expect(text).toContain("Code health 62/100");
    expect(text).toContain("4 findings");
    expect(text).toContain("2 high");
    expect(text).toContain("dead code 2 · unwired call 1 · contradiction 1");
    expect(text).toContain("http://web.test/p/prj_1/code-health");
  });

  it("fails the step when the audit JSON is missing", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: { kind: "step", step: auditStep } }));
    api.on("POST", routes.stepComplete("stp_audit"), () => ({ body: { credits_charged: 40, next: "continue", usage: usageSnapshot() } }));
    const runner: RunnerAdapter = { id: "claude", label: "f", isAvailable: async () => true, run: async () => ({ ok: true, finalText: "no json here", usage }) };
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {}, maxSteps: 1 });
    const complete = api.requests.find((r) => r.path === routes.stepComplete("stp_audit"))!;
    expect(complete.body).toMatchObject({ outcome: "failed", error: expect.stringContaining("audit step finished without") });
  });
});

describe("agnt0 audit", () => {
  beforeEach(async () => {
    await writeProjectFile(dir, { project_id: "prj_1", api_url: api.url, name: "demo" });
    process.chdir(dir);
  });

  it("queues an audit, prints the estimate and runs one step", async () => {
    api.on("POST", m2routes.audits("prj_1"), (r) => ({ status: 201, body: auditRun({ mode: r.body.mode }) }));
    const calls: unknown[] = [];
    const out = captureLog();
    const res = await auditCommand(makeCtx(api.url), { static: true, run: true }, out.log, async (_ctx, o) => (calls.push(o), { status: "idle", reason: "max_steps", message: "" }));
    expect(api.requests.find((r) => r.path === m2routes.audits("prj_1"))!.body).toEqual({ mode: "static", trigger: "manual" });
    expect(res.audit.mode).toBe("static");
    expect(calls).toEqual([{ once: true }]);
    expect(out.text()).toContain("~40 credits");
    expect(out.text()).toContain("static checks only");
  });

  it("--no-run only queues; a running audit isn't started twice", async () => {
    api.on("POST", m2routes.audits("prj_1"), () => ({ status: 201, body: auditRun() }));
    const never = async () => {
      throw new Error("must not run");
    };
    const out = captureLog();
    await auditCommand(makeCtx(api.url), { run: false }, out.log, never);
    expect(out.text()).toContain("runs first on your next agnt0 run");
    api.on("POST", m2routes.audits("prj_1"), () => ({ body: auditRun({ status: "running" }) }));
    await auditCommand(makeCtx(api.url), { run: true }, out.log, never);
    expect(out.text()).toContain("already running");
  });

  it("--skip skips the pending audit", async () => {
    api.on("GET", m2routes.audits("prj_1"), () => ({ body: { audits: [auditRun({ id: "aud_old", status: "completed" }), auditRun({ id: "aud_2" })] } }));
    api.on("POST", m2routesApi.auditSkip("aud_2"), () => ({ body: auditRun({ id: "aud_2", status: "skipped" }) }));
    const out = captureLog();
    const res = await auditCommand(makeCtx(api.url), { skip: true }, out.log);
    expect(res.audit.status).toBe("skipped");
    expect(out.text()).toContain("Skipped the audit");
  });
});

describe("agnt0 link", () => {
  it("says the Code Auditor was queued and runs first", async () => {
    process.chdir(dir);
    api.on("POST", routes.projects, (r) => ({ body: { id: "prj_new", name: r.body.name, phase: "define", brief: null, repo_sha: r.body.repo_sha, settings: { default_runner: "claude", runner_by_role: {}, approval_policy: "ask_risky" }, created_at: new Date().toISOString() } }));
    api.on("GET", m2routes.audits("prj_new"), () => ({ body: { audits: [auditRun({ project_id: "prj_new", trigger: "link" })] } }));
    const out = captureLog();
    await linkCommand(makeCtx(api.url), "legacy", {}, out.log, null);
    expect(out.text()).toContain("Code Auditor is queued");
    expect(out.text()).toContain("est. ~40 credits");
    expect(out.text()).toContain("agnt0 audit --skip");
  });
});
