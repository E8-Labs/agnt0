import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { truncate } from "../ui.js";
import { loadPlaywright } from "./chromium.js";

export type QaDevice = "mobile" | "tablet" | "desktop";
export type Severity = "low" | "medium" | "high";

export const QA_VIEWPORTS: Record<QaDevice, { width: number; height: number; mobile: boolean }> = {
  mobile: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false },
};

export interface QaShot {
  device: QaDevice;
  page: string;
  /** Index of the page in the run's page list (matches the upload key `<device>-<i>.png`). */
  index: number;
  file: string;
  contentType: "image/png" | "image/jpeg";
  bytes: number;
}

export interface QaLocalFinding {
  severity: Severity;
  device: QaDevice;
  page: string;
  index: number;
  title: string;
  url: string;
  repro_steps: string[];
}

export interface QaPassResult {
  shots: QaShot[];
  findings: QaLocalFinding[];
}

export interface QaPassOptions {
  baseUrl: string;
  pages: string[];
  devices: QaDevice[];
  outDir: string;
  /** Max bytes per screenshot (the upload limit); bigger PNGs are re-taken as JPEG. */
  maxBytes?: number;
  navigationTimeoutMs?: number;
  executablePath?: string;
  onProgress?: (device: QaDevice, page: string) => void;
}

const MAX_SHOT_BYTES = 5 * 1024 * 1024 - 64 * 1024;

export function pageUrl(baseUrl: string, page: string): string {
  return new URL(page.startsWith("/") ? page : `/${page}`, baseUrl.replace(/\/+$/, "") + "/").toString();
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function shortUrl(url: string, base: string): string {
  try {
    const u = new URL(url);
    return sameOrigin(url, base) ? u.pathname + u.search : url;
  } catch {
    return url;
  }
}

/** Noise every dev server makes that isn't a bug in the app. */
function ignorableRequest(url: string, failure: string | null): boolean {
  if (failure && /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return true;
  return /\/(_next\/webpack-hmr|__vite_ping|@vite\/client|sockjs-node|_expo\/ws|hot-update)/.test(url);
}

/**
 * Visits every page at every device size with headless Chromium, takes a full-page screenshot and
 * collects findings: console errors, uncaught page errors, failed requests (network errors and 4xx/5xx),
 * horizontal overflow at the device width, broken images and a missing <title>.
 */
export async function runQaPass(opts: QaPassOptions): Promise<QaPassResult> {
  const pw = await loadPlaywright();
  await mkdir(opts.outDir, { recursive: true });
  const shots: QaShot[] = [];
  const findings: QaLocalFinding[] = [];
  let browser: Browser | null = null;
  try {
    browser = await pw.chromium.launch({ headless: true, ...(opts.executablePath ? { executablePath: opts.executablePath } : {}) });
    for (const device of opts.devices) {
      const vp = QA_VIEWPORTS[device];
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        ignoreHTTPSErrors: true,
      });
      try {
        for (const [index, path] of opts.pages.entries()) {
          opts.onProgress?.(device, path);
          const page = await context.newPage();
          try {
            const res = await checkPage(page, { ...opts, device, path, index });
            findings.push(...res.findings);
            if (res.shot) shots.push(res.shot);
          } finally {
            await page.close().catch(() => {});
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  return { shots, findings };
}

async function checkPage(
  page: Page,
  o: QaPassOptions & { device: QaDevice; path: string; index: number },
): Promise<{ findings: QaLocalFinding[]; shot: QaShot | null }> {
  const vp = QA_VIEWPORTS[o.device];
  const url = pageUrl(o.baseUrl, o.path);
  const sizeText = `${vp.width}×${vp.height}`;
  const open = `Open ${url} at ${sizeText} (${o.device})`;
  const out: QaLocalFinding[] = [];
  const seen = new Set<string>();
  const add = (severity: Severity, title: string, steps: string[]) => {
    const key = `${severity}|${title}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      severity,
      device: o.device,
      page: o.path,
      index: o.index,
      title: truncate(title.replace(/\s+/g, " ").trim(), 200),
      url: truncate(url, 2000),
      repro_steps: [open, "Wait for the page to finish loading", ...steps].slice(0, 20).map((s) => truncate(s, 500)),
    });
  };

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Chromium logs every failed request as a console error too; the network check reports those.
    if (/^Failed to load resource/.test(text)) return;
    const loc = msg.location();
    const where = loc?.url ? ` (${shortUrl(loc.url, url)}${loc.lineNumber ? `:${loc.lineNumber + 1}` : ""})` : "";
    add("medium", `Console error: ${truncate(text.split("\n")[0] ?? text, 160)}`, [`Open the browser console: "${truncate(text, 400)}"${where}`]);
  });
  page.on("pageerror", (err) => {
    add("high", `Uncaught error: ${truncate(err.message.split("\n")[0] ?? err.message, 160)}`, [
      `An uncaught exception is thrown: ${truncate(err.message, 300)}`,
      ...(err.stack ? [`Stack: ${truncate(err.stack.split("\n").slice(1, 3).join(" ").trim(), 400)}`] : []),
    ]);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status < 400) return;
    const req = res.request();
    const rurl = res.url();
    if (ignorableRequest(rurl, null)) return;
    const isDoc = req.resourceType() === "document" && req.frame() === page.mainFrame();
    const isFavicon = /\/favicon\.(ico|png|svg)(\?|$)/.test(rurl);
    const severity: Severity = isDoc || status >= 500 ? "high" : isFavicon ? "low" : "medium";
    const what = isDoc ? "Page" : `${req.method()} ${shortUrl(rurl, url)}`;
    add(severity, `${what} returned HTTP ${status}`, [`${isDoc ? "The page itself" : `The ${req.resourceType()} request ${req.method()} ${truncate(rurl, 300)}`} responds with HTTP ${status} ${res.statusText()}`.trim()]);
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "failed";
    if (ignorableRequest(req.url(), failure)) return;
    add("medium", `Request failed: ${req.method()} ${truncate(shortUrl(req.url(), url), 120)} (${failure})`, [`The ${req.resourceType()} request ${req.method()} ${truncate(req.url(), 300)} fails with ${failure}`]);
  });

  let loaded = false;
  try {
    await page.goto(url, { waitUntil: "load", timeout: o.navigationTimeoutMs ?? 45_000 });
    loaded = true;
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  } catch (e) {
    add("high", `Page didn't load: ${truncate(e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e), 140)}`, ["The page never finishes loading"]);
  }

  if (loaded) {
    const facts = await page
      .evaluate(() => {
        const doc = document.documentElement;
        // clientWidth is the device width; with mobile emulation innerWidth grows to fit overflowing content.
        const vw = doc.clientWidth || window.innerWidth;
        const scrollWidth = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
        let widest: string | null = null;
        if (scrollWidth > vw + 1) {
          let maxRight = vw;
          for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 5000)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > maxRight + 0.5) {
              maxRight = r.right;
              const h = el as HTMLElement;
              const id = h.id ? `#${h.id}` : "";
              const cls = typeof h.className === "string" && h.className.trim() ? `.${h.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
              widest = `<${el.tagName.toLowerCase()}${id}${cls}> ${Math.round(r.width)}px wide`;
            }
          }
        }
        const broken = Array.from(document.images)
          .filter((img) => img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src))
          .map((img) => img.currentSrc || img.src)
          .slice(0, 10);
        return { vw, scrollWidth, widest, broken, title: document.title.trim() };
      })
      .catch(() => null);

    if (facts) {
      if (facts.scrollWidth > facts.vw + 1) {
        add("medium", `Horizontal overflow at ${vp.width}px: page is ${facts.scrollWidth}px wide`, [
          `Scroll sideways: the page is ${facts.scrollWidth}px wide in a ${facts.vw}px viewport`,
          ...(facts.widest ? [`Widest element: ${facts.widest}`] : []),
        ]);
      }
      for (const src of facts.broken) add("medium", `Broken image: ${truncate(shortUrl(src, url), 150)}`, [`The image ${truncate(src, 400)} doesn't render (it failed to load or decode)`]);
      if (!facts.title) add("low", "Missing <title>", ["The document has no <title>, so the browser tab and search results show the URL"]);
    }
  }

  const shot = await screenshot(page, o).catch(() => null);
  return { findings: out, shot };
}

async function screenshot(page: Page, o: QaPassOptions & { device: QaDevice; path: string; index: number }): Promise<QaShot> {
  const max = o.maxBytes ?? MAX_SHOT_BYTES;
  let buf = await page.screenshot({ fullPage: true, type: "png", animations: "disabled" });
  let contentType: QaShot["contentType"] = "image/png";
  if (buf.length > max) {
    contentType = "image/jpeg";
    buf = await page.screenshot({ fullPage: true, type: "jpeg", quality: 70, animations: "disabled" });
    if (buf.length > max) {
      const vp = QA_VIEWPORTS[o.device];
      buf = await page.screenshot({ type: "jpeg", quality: 60, clip: { x: 0, y: 0, width: vp.width, height: Math.min(8000, vp.height * 6) }, animations: "disabled" });
    }
  }
  const file = join(o.outDir, `${o.device}-${o.index}.${contentType === "image/png" ? "png" : "jpg"}`);
  await writeFile(file, buf);
  return { device: o.device, page: o.path, index: o.index, file, contentType, bytes: buf.length };
}
