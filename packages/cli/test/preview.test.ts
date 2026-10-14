import { m2routes } from "@agnt0/protocol";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPreview } from "../src/commands/preview.js";
import { detectDevServer } from "../src/preview/detect.js";
import { parseExpoUrl, parseLocalUrl } from "../src/preview/devserver.js";
import { renderPreviewHtml, startPreviewPage, type PreviewPageState } from "../src/preview/page-server.js";
import { PREVIEW_FILE, readLivePreview } from "../src/preview/session.js";
import { makeCtx, startMockApi, tempDir, type MockApi } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

const pkg = (p: object) => writeFile(join(dir, "package.json"), JSON.stringify(p));

describe("framework detection", () => {
  it("Next.js runs its dev script with PORT", async () => {
    await pkg({ scripts: { dev: "next dev" }, dependencies: { next: "15.0.0", react: "19" } });
    const plan = await detectDevServer(dir, 3005);
    expect(plan).toMatchObject({ framework: "next", label: "Next.js", pm: "npm", file: "npm", args: ["run", "dev"], port: 3005, env: { PORT: "3005" } });
  });

  it("Vite passes --port only to a plain vite script; pnpm from the lockfile", async () => {
    await pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } });
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    expect(await detectDevServer(dir, 5180)).toMatchObject({ framework: "vite", pm: "pnpm", file: "pnpm", args: ["run", "dev", "--", "--port", "5180"], port: 5180 });
    await pkg({ scripts: { dev: "concurrently vite api" }, devDependencies: { vite: "6" } });
    expect((await detectDevServer(dir, 5180)).args).toEqual(["run", "dev"]);
  });

  it("Expo starts expo with a port", async () => {
    await pkg({ dependencies: { expo: "52", "react-native": "0.76" } });
    await writeFile(join(dir, "yarn.lock"), "");
    expect(await detectDevServer(dir)).toMatchObject({ framework: "expo", pm: "yarn", file: "yarn", args: ["expo", "start", "--port", "8081"], port: 8081 });
  });

  it("falls back to a plain dev script, and explains when there's nothing to run", async () => {
    await pkg({ scripts: { dev: "node server.js" } });
    expect(await detectDevServer(dir)).toMatchObject({ framework: "npm", label: "npm dev script", args: ["run", "dev"], env: { PORT: "3000" } });
    await pkg({ scripts: { build: "tsc" } });
    await expect(detectDevServer(dir)).rejects.toThrow(/dev server/);
    await cleanup();
    ({ dir, cleanup } = await tempDir());
    await expect(detectDevServer(dir)).rejects.toThrow(/no package.json/);
  });

  it("reads the URL and Expo link dev servers print", () => {
    expect(parseLocalUrl("  \u001b[32m➜\u001b[39m  Local:   http://localhost:5174/")).toBe("http://localhost:5174");
    expect(parseLocalUrl("   - Local:        http://0.0.0.0:3001")).toBe("http://localhost:3001");
    expect(parseLocalUrl("  ➜  Network: http://192.168.1.4:5173/")).toBeNull();
    expect(parseExpoUrl("› Metro waiting on exp://192.168.1.4:8081")).toBe("exp://192.168.1.4:8081");
  });
});

const baseState: PreviewPageState = { project: "Demo <app>", framework: "vite", label: "Vite", target_url: "http://localhost:5173", expo_url: null, qr_svg: null, state: "running", message: null };

describe("preview page", () => {
  it("serves the bundled page, assets and live state", async () => {
    const page = await startPreviewPage(baseState, { port: 0 });
    try {
      const base = `http://127.0.0.1:${page.port}`;
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('data-device="mobile"');
      expect(html).toContain('data-device="tablet"');
      expect(html).toContain('data-device="desktop"');
      expect(html).toContain('id="rotate"');
      expect(html).toContain('id="reload"');
      expect(html).toContain("<iframe");
      // state is inlined safely (no raw "<" from the project name)
      expect(html).toContain("Demo \\u003capp\\u003e");
      const css = await fetch(`${base}/__agnt0/preview.css`);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(await css.text()).toContain("Geist");
      const js = await (await fetch(`${base}/__agnt0/preview.js`)).text();
      expect(js).toContain("390");
      expect(js).toContain("1180");
      expect(js).toContain("1440");
      page.update({ expo_url: "exp://10.0.0.2:8081", qr_svg: "<svg/>" });
      expect(await (await fetch(`${base}/__agnt0/state`)).json()).toMatchObject({ expo_url: "exp://10.0.0.2:8081", state: "running" });
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      // no network dependencies in the page
      expect(renderPreviewHtml({ ...baseState, target_url: null })).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(js).not.toMatch(/https?:\/\//);
    } finally {
      await page.close();
    }
  });
});

describe("startPreview", () => {
  let api: MockApi;
  beforeEach(async () => {
    api = await startMockApi();
  });
  afterEach(async () => {
    await api.close();
  });

  it("starts the dev server with env, serves the page, reports running then stopped", async () => {
    await pkg({ scripts: { dev: "node server.js" } });
    await writeFile(
      join(dir, "server.js"),
      `require("http").createServer((q, s) => s.end("<title>t</title>" + process.env.APP_SECRET_PRESENT)).listen(Number(process.env.PORT), () => console.log("ready on http://localhost:" + process.env.PORT));`,
    );
    const statuses: any[] = [];
    api.on("POST", m2routes.preview("prj_1"), (r) => (statuses.push(r.body), { body: { ...r.body, project_id: "prj_1", at: new Date().toISOString() } }));
    const ctx = makeCtx(api.url);
    const session = await startPreview({ root: dir, projectName: "demo", api: ctx.api, projectId: "prj_1", env: { APP_SECRET_PRESENT: "yes", PATH_NOT: "x" }, timeoutMs: 30_000 });
    try {
      expect(session.framework).toBe("npm");
      expect(await (await fetch(session.appUrl.replace("localhost", "127.0.0.1"))).text()).toContain("yes");
      const page = await (await fetch(`http://127.0.0.1:${session.page.port}/__agnt0/state`)).json();
      expect(page).toMatchObject({ project: "demo", target_url: session.appUrl, state: "running" });
      expect(existsSync(join(dir, PREVIEW_FILE))).toBe(true);
      expect((await readLivePreview(dir))?.app_url).toBe(session.appUrl);
      expect(statuses.map((s) => s.state)).toEqual(["starting", "running"]);
      expect(statuses[1]).toMatchObject({ local_url: session.page.url, framework: "npm", devices: ["mobile", "tablet", "desktop"] });
    } finally {
      await session.stop();
    }
    expect(statuses.at(-1)).toMatchObject({ state: "stopped", local_url: null });
    expect(existsSync(join(dir, PREVIEW_FILE))).toBe(false);
    expect(await session.devExit).not.toBeUndefined();
  });

  it("reports error when the dev server dies before it is ready", async () => {
    await pkg({ scripts: { dev: "node -e \"console.error('Cannot find module x'); process.exit(1)\"" } });
    const statuses: any[] = [];
    api.on("POST", m2routes.preview("prj_1"), (r) => (statuses.push(r.body), { body: {} }));
    await expect(startPreview({ root: dir, projectName: "demo", api: makeCtx(api.url).api, projectId: "prj_1", timeoutMs: 20_000 })).rejects.toThrow(/exited/);
    expect(statuses.map((s) => s.state)).toEqual(["starting", "error"]);
  });
});
