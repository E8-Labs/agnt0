import { Project, routes } from "@agnt0/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../src/commands/doctor.js";
import { logoutCommand } from "../src/commands/logout.js";
import { statusCommand } from "../src/commands/status.js";
import { usageCommand } from "../src/commands/usage.js";
import { watchCommand } from "../src/commands/watch.js";
import { creditsBuyCommand, creditsUseCommand, openCommand, upgradeCommand } from "../src/commands/web.js";
import { nodeCheck, summarize } from "../src/doctor.js";
import { buildProgram } from "../src/program.js";
import { writeProjectFile } from "../src/project.js";
import { initialWatchState, reduceWatch } from "../src/watch/state.js";
import { realtimeUrl } from "../src/watch/source.js";
import { captureLog, makeCtx, me, startMockApi, tempDir, usageSnapshot, validTokens, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  process.env.AGNT0_NO_BROWSER = "1";
  process.env.AGNT0_HOME = dir;
  process.exitCode = undefined;
});
afterEach(async () => {
  process.chdir(cwd);
  process.exitCode = undefined;
  await api.close();
  await cleanup();
});

const project: Project = {
  id: "prj_9",
  name: "habit-tracker",
  phase: "prototype",
  brief: null,
  repo_sha: null,
  settings: { default_runner: "claude", runner_by_role: {}, approval_policy: "ask_risky" },
  created_at: "2026-10-13T00:00:00Z",
};

describe("command smoke tests (API mocked)", () => {
  it("status shows account, plan, meters and linked project", async () => {
    api.on("GET", routes.me, () => ({ body: me() }));
    api.on("GET", routes.project("prj_9"), () => ({ body: project }));
    await writeProjectFile(dir, { project_id: "prj_9", api_url: api.url });
    process.chdir(dir);
    const out = captureLog();
    await statusCommand(makeCtx(api.url), {}, out.log);
    const t = out.text();
    expect(t).toContain("noah@example.com");
    expect(t).toContain("Pro (active)");
    expect(t).toContain("120/450 credits");
    expect(t).toContain("habit-tracker");
    expect(t).toContain("connected");
  });

  it("status shows the upgrade prompt without a plan", async () => {
    api.on("GET", routes.me, () => ({ body: me({ usage: usageSnapshot({ plan: "none", subscription_status: "none" }) }) }));
    process.chdir(dir);
    const out = captureLog();
    await statusCommand(makeCtx(api.url), {}, out.log);
    expect(out.text()).toContain("No active plan");
    expect(out.text()).toContain("http://web.test/plans");
  });

  it("status falls back to the cached account when offline", async () => {
    api.on("GET", routes.me, () => ({ body: me() }));
    process.chdir(dir);
    await statusCommand(makeCtx(api.url), {}, () => {});
    await api.close();
    const out = captureLog();
    await statusCommand(makeCtx(api.url), {}, out.log);
    expect(out.text()).toContain("offline · cached");
    api = await startMockApi();
  });

  it("usage prints meters, hosted-AI share and wallet", async () => {
    api.on("GET", routes.usage, () => ({ body: usageSnapshot() }));
    const out = captureLog();
    await usageCommand(makeCtx(api.url), {}, out.log);
    const t = out.text();
    expect(t).toContain("Session (5h)");
    expect(t).toContain("900/3600 credits");
    expect(t).toContain("30/1440 credits");
    expect(t).toContain("250 credits");
  });

  it("usage needs a login", async () => {
    await expect(usageCommand(makeCtx(api.url, null), {}, () => {})).rejects.toThrow(/not logged in/);
  });

  it("credits use turns keep_working on", async () => {
    api.on("PATCH", routes.usageSettings, (r) => ({ body: usageSnapshot({ wallet: { ...usageSnapshot().wallet, keep_working: r.body.keep_working } }) }));
    const out = captureLog();
    await creditsUseCommand(makeCtx(api.url), {}, out.log);
    expect(api.requests[0]!.body).toEqual({ keep_working: true });
    expect(out.text()).toContain("is on");
  });

  it("open, credits buy and upgrade point at the web app", async () => {
    const ctx = makeCtx(api.url);
    await writeProjectFile(dir, { project_id: "prj_9", api_url: api.url });
    process.chdir(dir);
    expect(await openCommand(ctx, () => {})).toBe("http://web.test/p/prj_9");
    expect(await creditsBuyCommand(ctx, () => {})).toBe("http://web.test/usage?buy=1");
    expect(await upgradeCommand(ctx, () => {})).toBe("http://web.test/plans");
  });

  it("logout revokes the refresh token and deletes local tokens", async () => {
    api.on("POST", routes.revoke, () => ({ status: 204 }));
    const ctx = makeCtx(api.url, validTokens({ email: "noah@example.com" }));
    const out = captureLog();
    await logoutCommand(ctx, out.log);
    expect(api.requests[0]!.body).toEqual({ refresh_token: "rt_1" });
    expect(ctx.store.data.size).toBe(0);
    expect(out.text()).toContain("Logged out");
  });

  it("doctor --json prints the report and uploads it when logged in", async () => {
    api.on("POST", routes.doctorReports, () => ({ status: 201, body: {} }));
    const fake = async () =>
      summarize([
        nodeCheck("22.1.0"),
        { id: "git", ok: true, detail: "git 2.43" },
        { id: "package_manager", ok: true, detail: "npm 10" },
        { id: "claude", ok: true, detail: "2.1.0" },
        { id: "claude_login", ok: true, detail: "logged in" },
        { id: "codex", ok: false, detail: "missing" },
        { id: "codex_login", ok: false, detail: "missing" },
        { id: "ports", ok: true, detail: "free" },
      ]);
    const out = captureLog();
    const res = await doctorCommand(makeCtx(api.url), { json: true }, out.log, fake);
    expect(res.ready).toBe(true);
    const printed = JSON.parse(out.text());
    expect(printed.checks).toHaveLength(8);
    expect(api.requests[0]!.path).toBe(routes.doctorReports);
    expect(api.requests[0]!.body.checks[0]).toMatchObject({ id: "node", ok: true });
    expect(process.exitCode).toBeUndefined();
  });

  it("doctor flags old Node and a missing runner", () => {
    expect(nodeCheck("18.19.0").ok).toBe(false);
    const r = summarize([nodeCheck("22.0.0"), { id: "git", ok: true, detail: "" }, { id: "package_manager", ok: true, detail: "" }, { id: "claude", ok: false, detail: "" }, { id: "claude_login", ok: false, detail: "" }, { id: "codex", ok: false, detail: "" }, { id: "codex_login", ok: false, detail: "" }, { id: "ports", ok: false, detail: "in use: 3000" }]);
    expect(r.ready).toBe(false);
    expect(r.fixes.claude).toMatch(/Install Claude Code/);
  });

  it("watch refuses to start without a TTY", async () => {
    await writeProjectFile(dir, { project_id: "prj_9", api_url: api.url });
    process.chdir(dir);
    await expect(watchCommand(makeCtx(api.url))).rejects.toThrow(/interactive terminal/);
  });

  it("--version and --help work without a login", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const p = buildProgram();
      p.exitOverride();
      await expect(p.parseAsync(["node", "agnt0", "--version"])).rejects.toMatchObject({ code: "commander.version" });
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      write.mockRestore();
    }
  });

  it("global --api points commands at another API", async () => {
    api.on("GET", routes.usage, () => ({ body: usageSnapshot() }));
    process.env.AGNT0_TOKEN = "ci_token";
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await buildProgram().parseAsync(["node", "agnt0", "--api", api.url, "usage", "--json"]);
      expect(api.requests[0]!.headers.authorization).toBe("Bearer ci_token");
      expect(JSON.parse(String(logs.mock.calls[0]![0])).plan).toBe("pro");
    } finally {
      delete process.env.AGNT0_TOKEN;
      logs.mockRestore();
    }
  });
});

describe("watch state", () => {
  it("tracks tiles, events, approvals and limits from realtime events", () => {
    let s = reduceWatch(initialWatchState, { type: "step.started", step_id: "stp_1", ticket_id: "tkt_1", role: "backend_developer", at: "2026-10-13T12:00:00Z" });
    s = reduceWatch(s, { type: "step.event", step_id: "stp_1", event: { type: "file_diff", summary: "Edit api.ts", at: "2026-10-13T12:00:05Z", data: { file: "api.ts" } } });
    expect(s.tiles[0]).toMatchObject({ role: "backend_developer", file: "api.ts", events: 1, status: "running" });
    s = reduceWatch(s, { type: "step.completed", step_id: "stp_1", outcome: "succeeded", credits_charged: 3, at: "2026-10-13T12:01:00Z" });
    expect(s.tiles[0]).toMatchObject({ status: "succeeded", credits: 3 });
    s = reduceWatch(s, {
      type: "ticket.updated",
      ticket: { id: "tkt_2", project_id: "prj", title: "Delete old table", description: "", acceptance_criteria: [], status: "approval", role: "backend_developer", priority: 1, depends_on: [], parallel_ok: true, lease_owner: null, lease_expires_at: null, created_at: "", updated_at: "" },
    });
    expect(s.approvals.map((t) => t.title)).toEqual(["Delete old table"]);
    expect(s.feed[0]!.text).toContain("succeeded");
  });

  it("builds the realtime URL with the token", () => {
    expect(realtimeUrl("http://localhost:8787", "prj_1", "t k")).toBe("ws://localhost:8787/v1/rt/projects/prj_1?token=t+k");
    expect(realtimeUrl("https://api.agnt0.dev", "p", "t")).toBe("wss://api.agnt0.dev/v1/rt/projects/p?token=t");
  });
});
