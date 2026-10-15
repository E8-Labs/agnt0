import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { m2routes } from "@agnt0/protocol";
import { setupTokenCommand } from "../src/commands/setup-token.js";
import { shareCommand } from "../src/commands/share.js";
import { writeProjectFile } from "../src/project.js";
import { makeCtx, startMockApi, tempDir, type MockApi } from "./helpers.js";

let api: MockApi;
let dir: string;
let cleanup: () => Promise<void>;
const cwd = process.cwd();
let out: string[];

beforeEach(async () => {
  api = await startMockApi();
  ({ dir, cleanup } = await tempDir());
  process.env.AGNT0_HOME = dir;
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    // eslint-disable-next-line no-control-regex
    out.push(a.map(String).join(" ").replace(/\u001b\[[0-9;]*m/g, ""));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  await api.close();
  await cleanup();
});

const token = (over: Record<string, unknown> = {}) => ({
  id: "cit_1",
  project_id: "prj_9",
  name: "CI",
  expires_at: new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
  last_used_at: null,
  created_at: new Date().toISOString(),
  ...over,
});

describe("agnt0 setup-token", () => {
  it("prints the secret once, with what it can and cannot do", async () => {
    api.on("POST", m2routes.setupToken, () => ({ status: 201, body: { token: token({ name: "github actions" }), secret: "a0c_SECRET" } }));
    await setupTokenCommand(makeCtx(api.url), { project: "prj_9", name: "github actions" });
    const text = out.join("\n");
    expect(text).toContain("a0c_SECRET");
    expect(text).toContain("only time it is shown");
    expect(text).toContain("AGNT0_TOKEN");
    // The limits are stated where the secret is, not buried in docs.
    expect(text).toContain("run the build loop and QA on this project");
    expect(text).toContain("cannot");
  });

  it("needs to know which project it is for", async () => {
    process.chdir(dir); // not a linked repo
    await expect(setupTokenCommand(makeCtx(api.url), {})).rejects.toThrow(/belongs to one project/i);
  });

  it("revokes by name, and says so when the name is not one", async () => {
    api.on("GET", m2routes.ciTokens, () => ({ status: 200, body: { tokens: [token({ name: "github actions" })] } }));
    let deleted: string | null = null;
    api.on("DELETE", m2routes.ciToken("cit_1"), () => {
      deleted = "cit_1";
      return { status: 200, body: { ok: true } };
    });
    await setupTokenCommand(makeCtx(api.url), { revoke: "github actions" });
    expect(deleted).toBe("cit_1");
    expect(out.join("\n")).toContain("stops working now");

    await expect(setupTokenCommand(makeCtx(api.url), { revoke: "nope" })).rejects.toThrow(/No CI token called/);
  });
});

describe("agnt0 share", () => {
  beforeEach(async () => {
    process.chdir(dir);
    await writeProjectFile(dir, { project_id: "prj_9", name: "habit-tracker", api_url: api.url });
  });

  it("says how to get cloudflared rather than failing obscurely", async () => {
    // PATH without cloudflared, which is also this machine's real state.
    await expect(shareCommand(makeCtx(api.url), {})).rejects.toThrow(/needs cloudflared/);
  });

  it("lists the live links and leaves the dead ones out", async () => {
    api.on("GET", m2routes.shareLinks("prj_9"), () => ({
      status: 200,
      body: {
        links: [
          { id: "shr_1", project_id: "prj_9", url: "https://a.trycloudflare.com", kind: "tunnel", label: "for Sam", status: "active", expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date().toISOString() },
          { id: "shr_2", project_id: "prj_9", url: "https://b.trycloudflare.com", kind: "tunnel", label: null, status: "revoked", expires_at: new Date().toISOString(), created_at: new Date().toISOString() },
        ],
      },
    }));
    await shareCommand(makeCtx(api.url), { list: true });
    const text = out.join("\n");
    expect(text).toContain("https://a.trycloudflare.com");
    expect(text).toContain("for Sam");
    expect(text).not.toContain("https://b.trycloudflare.com");
  });

  it("revokes by id or by the address itself", async () => {
    api.on("GET", m2routes.shareLinks("prj_9"), () => ({
      status: 200,
      body: {
        links: [
          { id: "shr_1", project_id: "prj_9", url: "https://a.trycloudflare.com", kind: "tunnel", label: null, status: "active", expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: new Date().toISOString() },
        ],
      },
    }));
    let deleted = 0;
    api.on("DELETE", m2routes.shareLink("shr_1"), () => {
      deleted += 1;
      return { status: 200, body: { ok: true } };
    });
    await shareCommand(makeCtx(api.url), { revoke: "https://a.trycloudflare.com" });
    expect(deleted).toBe(1);
    await expect(shareCommand(makeCtx(api.url), { revoke: "https://nope.example" })).rejects.toThrow(/No share link matching/);
  });
});
