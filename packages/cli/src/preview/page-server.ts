import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { freePort } from "../net.js";
import css from "./page/preview.css?raw";
import html from "./page/index.html?raw";
import js from "./page/preview.js?raw";

export type PreviewState = "starting" | "running" | "stopped" | "error";

/** What the preview page shows; served at /__agnt0/state and inlined into the first response. */
export interface PreviewPageState {
  project: string;
  framework: string | null;
  label: string | null;
  target_url: string | null;
  expo_url: string | null;
  qr_svg: string | null;
  state: PreviewState;
  message: string | null;
}

export interface PreviewPage {
  url: string;
  port: number;
  update(patch: Partial<PreviewPageState>): void;
  get(): PreviewPageState;
  close(): Promise<void>;
}

/** JSON that is safe inside a <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderPreviewHtml(state: PreviewPageState): string {
  return html.replace("<!--AGNT0_STATE-->", `<script>window.__AGNT0__ = ${scriptJson(state)};</script>`);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * Serves the built-in preview page (bundled HTML/CSS/JS, no network dependencies) on 127.0.0.1.
 * The page frames the app's dev server at fixed device sizes and polls /__agnt0/state.
 */
export async function startPreviewPage(initial: PreviewPageState, opts: { port?: number } = {}): Promise<PreviewPage> {
  let state = { ...initial };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, SECURITY_HEADERS).end();
      return;
    }
    const send = (type: string, body: string) => {
      res.writeHead(200, { "content-type": type, ...SECURITY_HEADERS });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (path === "/" || path === "/index.html") return send("text/html; charset=utf-8", renderPreviewHtml(state));
    if (path === "/__agnt0/preview.css") return send("text/css; charset=utf-8", css);
    if (path === "/__agnt0/preview.js") return send("text/javascript; charset=utf-8", js);
    if (path === "/__agnt0/state") return send("application/json", JSON.stringify(state));
    if (path === "/__agnt0/health") return send("application/json", '{"ok":true}');
    res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS }).end("Not found");
  });
  const port = opts.port ?? (await freePort(4400));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${actual}`,
    port: actual,
    update: (patch) => {
      state = { ...state, ...patch };
    },
    get: () => state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
