import { m2routes } from "@agnt0/protocol";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseDevices, parsePages, qaCommand, uploadFor } from "../src/commands/qa.js";
import { writeProjectFile } from "../src/project.js";
import { chromiumStatus } from "../src/qa/chromium.js";
import { runQaPass } from "../src/qa/runner.js";
import { captureLog, makeCtx, makeRepo, startMockApi, tempDir, type MockApi } from "./helpers.js";

/** A tiny app with planted bugs: a console error, horizontal overflow, a broken image, a missing title, a 404 asset. */
let app: Server;
let appUrl: string;
const PAGES: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Home</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><h1>Home</h1><script>console.error("boom: planted console error")</script></body></html>`,
  "/wide": `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><div class="banner" style="width:1600px;height:20px;background:#ccc"></div>
<img src="/missing.png" width="10" height="10"><script src="/gone.js"></script></body></html>`,
};
beforeAll(async () => {
  app = createServer((req, res) => {
    const body = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
});

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

describe("argument parsing", () => {
  it("validates devices and normalises pages", () => {
    expect(parseDevices(undefined)).toEqual(["mobile", "tablet", "desktop"]);
    expect(parseDevices("Mobile, desktop,mobile")).toEqual(["mobile", "desktop"]);
    expect(() => parseDevices("watch")).toThrow(/Unknown device/);
    expect(parsePages("/,about, /pricing")).toEqual(["/", "/about", "/pricing"]);
    expect(parsePages(undefined)).toEqual(["/"]);
  });
  it("matches upload slots by key, then by order", () => {
    const u = (key: string) => ({ key, put_url: `http://x/${key}`, get_url: "", expires_in_s: 60 });
    const uploads = [u("p/1/qa/r/mobile-0.png"), u("p/1/qa/r/mobile-1.png"), u("p/1/qa/r/desktop-0.png"), u("p/1/qa/r/desktop-1.png")];
    expect(uploadFor(uploads, ["mobile", "desktop"], ["/", "/a"], "desktop", 1)?.key).toBe("p/1/qa/r/desktop-1.png");
    expect(uploadFor([u("a"), u("b"), u("c")], ["mobile", "desktop"], ["/"], "desktop", 0)?.key).toBe("b");
  });
});

describe.runIf((await chromiumStatus()).installed)("QA pass (headless Chromium)", () => {
  it("finds the planted problems and takes full-page screenshots", async () => {
    const res = await runQaPass({ baseUrl: appUrl, pages: ["/", "/wide"], devices: ["mobile", "desktop"], outDir: join(dir, "shots") });
    expect(res.shots).toHaveLength(4);
    for (const s of res.shots) {
      expect(existsSync(s.file)).toBe(true);
      expect((await readFile(s.file)).subarray(1, 4).toString()).toBe("PNG");
    }
    const titles = (device: string, page: string) => res.findings.filter((f) => f.device === device && f.page === page).map((f) => `${f.severity}: ${f.title}`);
    const homeMobile = titles("mobile", "/");
    expect(homeMobile).toEqual([expect.stringMatching(/^medium: Console error: boom: planted console error/)]);

    const wideMobile = titles("mobile", "/wide");
    expect(wideMobile).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^medium: Horizontal overflow at 390px: page is 1600px wide/),
        expect.stringMatching(/^medium: Broken image: \/missing\.png/),
        "low: Missing <title>",
        expect.stringMatching(/^medium: GET \/gone\.js returned HTTP 404/),
        expect.stringMatching(/^medium: GET \/missing\.png returned HTTP 404/),
      ]),
    );
    // 1440 wide: still overflows (1600px), so it's reported there too
    expect(titles("desktop", "/wide").some((t) => t.includes("Horizontal overflow at 1440px"))).toBe(true);
    const overflow = res.findings.find((f) => f.title.startsWith("Horizontal overflow") && f.device === "mobile")!;
    expect(overflow.repro_steps[0]).toBe(`Open ${appUrl}/wide at 390×844 (mobile)`);
    expect(overflow.repro_steps.join(" ")).toContain("div.banner");
  });

  describe("agnt0 qa", () => {
    let api: MockApi;
    const cwd = process.cwd();
    beforeEach(async () => {
      api = await startMockApi();
      await makeRepo(dir);
      await writeProjectFile(dir, { project_id: "prj_1", api_url: api.url, name: "demo" });
      process.chdir(dir);
    });
    afterEach(async () => {
      process.chdir(cwd);
      await api.close();
    });

    const qaRun = (over: object = {}) => ({ id: "qar_1", project_id: "prj_1", build_sha: null, devices: ["mobile"], status: "running", findings_count: 0, screenshots: [], created_at: new Date().toISOString(), completed_at: null, ...over });

    it("opens a run, uploads screenshots through signed URLs and posts findings", async () => {
      const keys = ["p/prj_1/qa/qar_1/mobile-0.png", "p/prj_1/qa/qar_1/mobile-1.png"];
      api.on("POST", m2routes.qaRuns("prj_1"), () => ({
        status: 201,
        body: { qa_run: qaRun(), uploads: keys.map((key) => ({ key, put_url: `${api.url}/v1/blobs/${key}?exp=1&sig=s`, get_url: `${api.url}/v1/blobs/${key}?exp=1&sig=g`, expires_in_s: 900 })) },
      }));
      for (const k of keys) api.on("PUT", `/v1/blobs/${k}`, () => ({ body: { ok: true } }));
      api.on("POST", m2routes.qaRunComplete("qar_1"), (r) => ({
        body: {
          qa_run: qaRun({ status: r.body.status, findings_count: r.body.findings.length, completed_at: new Date().toISOString() }),
          findings: r.body.findings.map((f: any, i: number) => ({ ...f, id: `qaf_${i}`, screenshot_url: null, ticket_id: f.severity === "low" ? null : `tkt_${i}` })),
        },
      }));
      const out = captureLog();
      const res = await qaCommand(makeCtx(api.url), { devices: "mobile", pages: "/,/wide", url: appUrl }, out.log, null);
      expect(res.status).toBe("completed");

      const create = api.requests.find((r) => r.path === m2routes.qaRuns("prj_1"))!;
      expect(create.body).toMatchObject({ devices: ["mobile"], pages: ["/", "/wide"], base_url: appUrl });
      expect(create.body.build_sha).toMatch(/^[0-9a-f]{40}$/);

      const puts = api.requests.filter((r) => r.method === "PUT");
      expect(puts).toHaveLength(2);
      for (const p of puts) {
        expect(p.headers["content-type"]).toBe("image/png");
        expect(p.headers.authorization).toBeUndefined();
        expect(p.raw.subarray(1, 4).toString()).toBe("PNG");
      }

      const complete = api.requests.find((r) => r.path === m2routes.qaRunComplete("qar_1"))!;
      expect(complete.body.status).toBe("failed");
      expect(complete.body.screenshots).toEqual([
        { device: "mobile", key: keys[0], page: "/" },
        { device: "mobile", key: keys[1], page: "/wide" },
      ]);
      const consoleErr = complete.body.findings.find((f: any) => f.title.startsWith("Console error"));
      expect(consoleErr).toMatchObject({ severity: "medium", device: "mobile", screenshot_key: keys[0], url: `${appUrl}/` });
      expect(consoleErr.repro_steps.length).toBeGreaterThanOrEqual(3);
      const overflow = complete.body.findings.find((f: any) => f.title.startsWith("Horizontal overflow"));
      expect(overflow.screenshot_key).toBe(keys[1]);

      const text = out.text();
      expect(text).toMatch(/PAGE\s+MOBILE/);
      expect(text).toContain("QA found issues");
      expect(text).toContain("http://web.test/p/prj_1/qa");
      expect(text).toMatch(/became bug tickets? on your board/);
    });

    it("pauses on 402 like run does, without driving the browser", async () => {
      api.on("POST", m2routes.qaRuns("prj_1"), () => ({ status: 402, body: { error: "credits_exhausted", message: "empty", upgrade_url: "http://web.test/plans" } }));
      const out = captureLog();
      const res = await qaCommand(makeCtx(api.url), { devices: "mobile", url: appUrl }, out.log, null);
      expect(res).toEqual({ status: "paused", code: "credits_exhausted" });
      expect(out.text()).toContain("agnt0 credits buy");
      expect(api.requests.some((r) => r.path.includes("/complete"))).toBe(false);
    });
  });
});
