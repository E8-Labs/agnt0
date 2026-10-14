import { routes, type Step } from "@agnt0/protocol";
import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLoop } from "../src/run/loop.js";
import type { RunnerAdapter, RunnerInput, RunnerResult } from "../src/runners/types.js";
import { captureLog, makeCtx, makeRepo, startMockApi, tempDir, usageSnapshot, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  await makeRepo(dir);
  api.on("POST", routes.heartbeat, () => ({ status: 204 }));
});
afterEach(async () => {
  await api.close();
  await cleanup();
});

const PROMPT = "SECRET-ROLE-PROMPT do the ticket";

function step(over: Partial<Step> = {}): Step {
  return {
    step_id: "stp_1",
    project_id: "prj_1",
    ticket_id: "tkt_41",
    kind: "build",
    role: "frontend_developer",
    runner: "claude",
    model: "sonnet",
    prompt: PROMPT,
    output_schema: null,
    compression: { read: [], write: "full" },
    allowed_tools: ["read", "write"],
    scope: [],
    worktree: ".agnt0/wt/tkt_41",
    branch: "agnt0/tkt_41",
    approval: { requires_approval: [] },
    checkpoint_before: true,
    lease_expires_at: "2026-10-13T13:00:00Z",
    max_turns: 30,
    ...over,
  };
}

class FakeRunner implements RunnerAdapter {
  readonly id = "claude" as const;
  readonly label = "Fake";
  inputs: RunnerInput[] = [];
  constructor(private readonly impl: (i: RunnerInput) => Promise<RunnerResult>) {}
  async isAvailable() {
    return true;
  }
  run(i: RunnerInput) {
    this.inputs.push(i);
    return this.impl(i);
  }
}

const usage = { runner: "claude" as const, model: "claude-sonnet-4-5", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 5000, cache_write_tokens: 0, raw_tool_tokens: 0, sent_tool_tokens: 0 };

const limitBody = {
  error: "limit_reached",
  message: "Session limit reached",
  limit: "session",
  used: 450,
  allowance: 450,
  resets_at: "2026-10-13T15:00:00Z",
  options: ["wait", "extra_credits", "upgrade"],
  buy_url: "http://web.test/usage?buy=1",
  upgrade_url: "http://web.test/plans",
};

describe("agnt0 run", () => {
  it("pauses cleanly on 402 limit_reached: prints the reset and both ways to keep going", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ status: 402, body: limitBody }));
    const out = captureLog();
    const runner = new FakeRunner(async () => {
      throw new Error("must not run");
    });
    const ctx = makeCtx(api.url);
    const exit = await runLoop({ api: ctx.api, projectId: "prj_1", repoRoot: dir, webUrl: "http://web.test", runners: [runner], log: out.log, sleep: async () => {} });

    expect(exit).toEqual({ status: "paused", code: "limit_reached" });
    expect(runner.inputs).toHaveLength(0);
    const text = out.text();
    expect(text).toContain("5-hour session limit reached (450/450 credits)");
    expect(text).toContain("Resets");
    expect(text).toContain("agnt0 credits use");
    expect(text).toContain("agnt0 upgrade");
    const next = api.requests.find((r) => r.path === routes.stepsNext("prj_1"))!;
    expect(next.body).toMatchObject({ runner_available: ["claude"], max_parallel: 1 });
    expect(next.body.repo_sha).toMatch(/^[0-9a-f]{40}$/);
    // heartbeat reported the paused state
    await new Promise((r) => setTimeout(r, 50));
    expect(api.requests.some((r) => r.path === routes.heartbeat && r.body.state === "paused")).toBe(true);
  });

  it("explains plan_required and credits_exhausted", async () => {
    const out = captureLog();
    const runner = new FakeRunner(async () => ({ ok: true, finalText: "", usage }));
    const ctx = makeCtx(api.url);
    api.on("POST", routes.stepsNext("prj_1"), () => ({ status: 402, body: { error: "credits_exhausted", message: "empty", upgrade_url: "http://web.test/plans" } }));
    expect(await runLoop({ api: ctx.api, projectId: "prj_1", repoRoot: dir, webUrl: "http://web.test", runners: [runner], log: out.log })).toEqual({ status: "paused", code: "credits_exhausted" });
    expect(out.text()).toContain("agnt0 credits buy");
    api.on("POST", routes.stepsNext("prj_1"), () => ({ status: 402, body: { error: "plan_required", message: "plan", upgrade_url: "http://web.test/plans" } }));
    expect(await runLoop({ api: ctx.api, projectId: "prj_1", repoRoot: dir, webUrl: "http://web.test", runners: [runner], log: out.log })).toEqual({ status: "paused", code: "plan_required" });
    expect(out.text()).toContain("active Agent Zero plan");
  });

  it("tells the user to upgrade the CLI on 426", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ status: 426, body: { error: "protocol_outdated", message: "old" } }));
    const runner = new FakeRunner(async () => ({ ok: true, finalText: "", usage }));
    await expect(runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {} })).rejects.toThrow(/too old/);
  });

  it("exits on idle with the server's reason", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: { kind: "idle", reason: "waiting_approval", message: "2 tickets wait for your approval" } }));
    const out = captureLog();
    const exit = await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [new FakeRunner(async () => ({ ok: true, finalText: "", usage }))], log: out.log });
    expect(exit).toMatchObject({ status: "idle", reason: "waiting_approval" });
    expect(out.text()).toContain("2 tickets wait for your approval");
  });

  it("runs several steps at once, tags their output and waits for them before reporting idle", async () => {
    const ids = ["tkt_aaaaaa1", "tkt_bbbbbb2", "tkt_cccccc3"];
    // Three tickets ready, then the server says nothing is ready while they are still running.
    const queue = ids.map((id, i) => ({
      kind: "step",
      step: step({ step_id: `stp_${i + 1}`, ticket_id: id, worktree: `.agnt0/wt/${id}`, branch: `agnt0/${id}` }),
    }));
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: queue.shift() ?? { kind: "idle", reason: "no_ready_tickets", message: "Nothing ready" } }));
    api.on("POST", routes.stepEvents(""), () => ({ status: 202, body: { accepted: 1 } }));
    for (let i = 1; i <= 3; i++) {
      api.on("POST", routes.stepComplete(`stp_${i}`), () => ({ body: { credits_charged: 2, next: "continue", usage: usageSnapshot() } }));
    }

    // Each step blocks until released, so all three can only finish if they really ran together.
    let peak = 0;
    let running = 0;
    const release: Array<() => void> = [];
    const started: string[] = [];
    const runner = new FakeRunner(async (input) => {
      started.push(input.step.ticket_id!);
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => release.push(r));
      running--;
      return { ok: true, finalText: "done", usage };
    });

    const out = captureLog();
    const ctx = makeCtx(api.url);
    const loop = runLoop({ api: ctx.api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: out.log, parallel: 3 });

    // Wait for all three to be in flight, then let them go.
    for (let i = 0; i < 200 && release.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(release).toHaveLength(3);
    for (const r of release) r();

    const exit = await loop;
    expect(exit).toMatchObject({ status: "idle", reason: "no_ready_tickets" });
    expect(peak).toBe(3);
    expect(new Set(started)).toEqual(new Set(ids));

    // It asked for three slots, and each line says which ticket it belongs to.
    const next = api.requests.find((r) => r.path === routes.stepsNext("prj_1"))!;
    expect(next.body).toMatchObject({ max_parallel: 3 });
    const text = out.text();
    for (const id of ids) expect(text).toContain(`[${id.replace("tkt_", "").slice(0, 6)}]`);
  });

  it("keeps one slot sequential and untagged by default", async () => {
    const queue = [
      { kind: "step", step: step({ step_id: "stp_1", ticket_id: "tkt_aaaaaa1" }) },
      { kind: "idle", reason: "all_done", message: "Every ticket is done." },
    ];
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: queue.shift() }));
    api.on("POST", routes.stepEvents(""), () => ({ status: 202, body: { accepted: 1 } }));
    api.on("POST", routes.stepComplete("stp_1"), () => ({ body: { credits_charged: 2, next: "continue", usage: usageSnapshot() } }));
    let peak = 0;
    let running = 0;
    const runner = new FakeRunner(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { ok: true, finalText: "done", usage };
    });
    const out = captureLog();
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: out.log });
    expect(peak).toBe(1);
    expect(api.requests.find((r) => r.path === routes.stepsNext("prj_1"))!.body).toMatchObject({ max_parallel: 1 });
    expect(out.text()).not.toContain("[aaaaaa");
  });

  it("runs a step in its worktree, streams events, commits the work and completes it", async () => {
    const steps = [{ kind: "step", step: step() }, { kind: "idle", reason: "no_ready_tickets", message: "Nothing ready" }];
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: steps.shift() }));
    api.on("POST", routes.stepEvents("stp_1"), () => ({ status: 202, body: { accepted: 1 } }));
    api.on("POST", routes.stepComplete("stp_1"), () => ({ body: { credits_charged: 2, next: "continue", usage: usageSnapshot({ session: { kind: "session", used: 400, allowance: 450, started_at: null, resets_at: "2026-10-13T15:00:00Z" } }) } }));

    const runner = new FakeRunner(async (i) => {
      i.onEvent({ type: "file_diff", summary: "Write src/screen.tsx", at: new Date().toISOString(), data: { file: "src/screen.tsx" } });
      await writeFile(join(i.cwd, "screen.tsx"), "export const Screen = () => null;\n");
      return { ok: true, finalText: "Built the onboarding screen.", usage };
    });
    const out = captureLog();
    const exit = await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: out.log, sleep: async () => {} });
    expect(exit).toMatchObject({ status: "idle", reason: "no_ready_tickets" });

    expect(runner.inputs[0]!.cwd).toBe(join(dir, ".agnt0", "wt", "tkt_41"));
    expect(runner.inputs[0]!.step.prompt).toBe(PROMPT);

    const events = api.requests.find((r) => r.path === routes.stepEvents("stp_1"))!;
    expect(events.body.events[0]).toMatchObject({ type: "file_diff", summary: "Write src/screen.tsx" });

    const complete = api.requests.find((r) => r.path === routes.stepComplete("stp_1"))!;
    expect(complete.body).toMatchObject({ outcome: "succeeded", summary: "Built the onboarding screen.", usage, diff: { files_changed: 1, lines_added: 1, lines_removed: 0 } });
    const branchHead = (await execa("git", ["rev-parse", "agnt0/tkt_41"], { cwd: dir })).stdout.trim();
    expect(complete.body.diff.head_sha).toBe(branchHead);
    expect((await execa("git", ["log", "-1", "--format=%s", "agnt0/tkt_41"], { cwd: dir })).stdout).toBe("agnt0: tkt_41 frontend_developer");
    expect((await execa("git", ["rev-parse", "--verify", "refs/agnt0/checkpoints/stp_1"], { cwd: dir })).exitCode).toBe(0);

    // the prompt never leaves memory: not in output, not in any request, not on disk in the repo
    expect(out.text()).not.toContain("SECRET-ROLE-PROMPT");
    expect(JSON.stringify(api.requests.map((r) => r.body))).not.toContain("SECRET-ROLE-PROMPT");
    const grep = await execa("git", ["grep", "-r", "SECRET-ROLE-PROMPT", "agnt0/tkt_41"], { cwd: dir, reject: false });
    expect(grep.stdout).toBe("");
    expect(out.text()).toContain("89% of your 5-hour session limit used");
  });

  it("sends the JSON output for schema steps and fails when it is missing", async () => {
    const queue = [
      { kind: "step", step: step({ step_id: "stp_plan", kind: "plan", role: "planner", worktree: null, branch: null, output_schema: "plan", checkpoint_before: false }) },
      { kind: "step", step: step({ step_id: "stp_plan2", kind: "plan", role: "planner", worktree: null, branch: null, output_schema: "plan", checkpoint_before: false }) },
      { kind: "idle", reason: "all_done", message: "done" },
    ];
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: queue.shift() }));
    for (const id of ["stp_plan", "stp_plan2"]) {
      api.on("POST", routes.stepComplete(id), () => ({ body: { credits_charged: 3, next: "continue", usage: usageSnapshot() } }));
      api.on("POST", routes.stepEvents(id), () => ({ status: 202 }));
    }
    const answers = ['Plan ready.\n```json\n{"tickets":[{"key":"T1"}]}\n```', "I forgot the JSON."];
    const runner = new FakeRunner(async () => ({ ok: true, finalText: answers.shift()!, usage }));
    await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {} });

    expect(runner.inputs[0]!.cwd).toBe(dir);
    const c1 = api.requests.find((r) => r.path === routes.stepComplete("stp_plan"))!;
    expect(c1.body).toMatchObject({ outcome: "succeeded", output: { tickets: [{ key: "T1" }] } });
    const c2 = api.requests.find((r) => r.path === routes.stepComplete("stp_plan2"))!;
    expect(c2.body.outcome).toBe("failed");
    expect(c2.body.error).toMatch(/required JSON output/);
  });

  it("reports the running step as interrupted on Ctrl-C", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: { kind: "step", step: step() } }));
    api.on("POST", routes.stepEvents("stp_1"), () => ({ status: 202 }));
    api.on("POST", routes.stepComplete("stp_1"), () => ({ body: { credits_charged: 1, next: "continue", usage: usageSnapshot() } }));
    const ac = new AbortController();
    const runner = new FakeRunner(
      (i) =>
        new Promise((resolve) => {
          i.signal.addEventListener("abort", () => resolve({ ok: false, finalText: "", usage, error: "interrupted" }));
          setTimeout(() => ac.abort(), 20);
        }),
    );
    const exit = await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [runner], log: () => {}, signal: ac.signal });
    expect(exit).toEqual({ status: "interrupted" });
    const complete = api.requests.find((r) => r.path === routes.stepComplete("stp_1"))!;
    expect(complete.body).toMatchObject({ outcome: "failed", error: "interrupted" });
    expect(api.requests.filter((r) => r.path === routes.stepsNext("prj_1"))).toHaveLength(1);
  });

  it("stops with pause_limit from step completion", async () => {
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: { kind: "step", step: step({ worktree: null, branch: null, checkpoint_before: false }) } }));
    api.on("POST", routes.stepEvents("stp_1"), () => ({ status: 202 }));
    api.on("POST", routes.stepComplete("stp_1"), () => ({ body: { credits_charged: 4, next: "pause_limit", usage: usageSnapshot() } }));
    const out = captureLog();
    const exit = await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [new FakeRunner(async () => ({ ok: true, finalText: "ok", usage }))], log: out.log });
    expect(exit).toEqual({ status: "paused", code: "limit_reached" });
    expect(out.text()).toContain("agnt0 credits use");
  });

  it("prints a completion summary when every ticket is done", async () => {
    // two ticket branches: one merged into main already, one still to merge
    await execa("git", ["branch", "agnt0/tkt_1"], { cwd: dir });
    await execa("git", ["checkout", "-q", "-b", "agnt0/tkt_2"], { cwd: dir });
    await execa("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "--allow-empty", "-m", "work"], { cwd: dir });
    await execa("git", ["checkout", "-q", "-"], { cwd: dir });
    const ticket = (id: string) => ({ id, project_id: "prj_1", title: id, description: "", acceptance_criteria: ["x"], status: "done", role: "frontend_developer", priority: 1, depends_on: [], parallel_ok: true, lease_owner: null, lease_expires_at: null, created_at: "", updated_at: "" });
    api.on("POST", routes.stepsNext("prj_1"), () => ({ body: { kind: "idle", reason: "all_done", message: "Every ticket is done." } }));
    api.on("GET", routes.tickets("prj_1"), () => ({ body: { tickets: [ticket("tkt_1"), ticket("tkt_2")] } }));
    const step = (id: string, credits: number) => ({ id, ticket_id: null, kind: "build", role: "frontend_developer", model: "sonnet", status: "succeeded", summary: null, credits_charged: credits, started_at: "", ended_at: null });
    api.on("GET", routes.activity("prj_1"), () => ({ body: { steps: [step("s1", 5), step("s2", 7)], events: [] } }));
    const out = captureLog();
    const exit = await runLoop({ api: makeCtx(api.url).api, projectId: "prj_1", repoRoot: dir, webUrl: "w", runners: [new FakeRunner(async () => ({ ok: true, finalText: "", usage }))], log: out.log });
    expect(exit).toMatchObject({ status: "idle", reason: "all_done" });
    expect(out.lines.at(-1)).toBe("✓ All 2 tickets done · 12 credits used · 1 branch to merge: agnt0/tkt_2");
  });
});
