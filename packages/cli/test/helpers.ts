import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageSnapshot } from "@agnt0/protocol";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
  /** Raw request body (for binary uploads such as signed blob PUTs). */
  raw: Buffer;
  query: URLSearchParams;
}

export type Handler = (req: RecordedRequest) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export interface MockApi {
  url: string;
  requests: RecordedRequest[];
  routes: Map<string, Handler>;
  on(method: string, path: string, h: Handler): void;
  close(): Promise<void>;
}

/** Tiny HTTP server standing in for the Agent Zero API. Routes are matched on "METHOD /path". */
export async function startMockApi(): Promise<MockApi> {
  const routes = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const buf = Buffer.concat(chunks);
    const [path = "/", qs = ""] = (req.url ?? "/").split("?");
    const isJson = !req.headers["content-type"] || /json/.test(req.headers["content-type"]);
    let body: unknown;
    if (buf.length && isJson) {
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    const rec: RecordedRequest = { method: req.method ?? "GET", path, headers: req.headers, body, raw: buf, query: new URLSearchParams(qs) };
    requests.push(rec);
    const h = routes.get(`${rec.method} ${path}`);
    const out = h?.(rec);
    if (!out) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: `no mock for ${rec.method} ${path}` }));
      return;
    }
    res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(out.body === undefined ? "" : JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    routes,
    on: (method, path, h) => routes.set(`${method} ${path}`, h),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function tempDir(prefix = "agnt0-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const gitEnv = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export async function makeRepo(dir: string, withCommit = true): Promise<void> {
  await execa("git", ["init", "-q"], { cwd: dir });
  if (withCommit) {
    await execa("git", ["-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  }
}

export function usageSnapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    plan: "pro",
    subscription_status: "active",
    session: { kind: "session", used: 120, allowance: 450, started_at: "2026-10-13T10:00:00Z", resets_at: "2026-10-13T15:00:00Z" },
    week: { kind: "week", used: 900, allowance: 3600, started_at: "2026-10-10T00:00:00Z", resets_at: "2026-10-17T00:00:00Z" },
    hosted_ai: { used: 30, cap: 1440 },
    onboarding_allowance_left: 0,
    wallet: { balance: 250, keep_working: false, auto_reload_pack: "none", monthly_spend_cap_usd: 50, spent_this_month_usd: 10 },
    max_parallel_agents: 4,
    ...over,
  };
}

export function me(over: Record<string, unknown> = {}) {
  return { id: "usr_1", email: "noah@example.com", name: "Noah", usage: usageSnapshot(), cli_sessions: [], ...over };
}

export function captureLog(): { log: (l: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  // eslint-disable-next-line no-control-regex
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
  return { log: (l) => lines.push(strip(l)), lines, text: () => lines.join("\n") };
}

import { ApiClient } from "../src/api/client.js";
import { AuthSession } from "../src/auth/session.js";
import { MemoryTokenStore, type StoredTokens } from "../src/auth/store.js";
import type { Context } from "../src/context.js";

export function makeCtx(apiUrl: string, tokens: StoredTokens | null = validTokens()): Context & { store: MemoryTokenStore } {
  const store = new MemoryTokenStore();
  if (tokens) store.data.set(apiUrl, tokens);
  const session = new AuthSession(store, apiUrl, undefined, {});
  return { apiUrl, webUrl: "http://web.test", store, session, api: new ApiClient({ baseUrl: apiUrl, tokens: session, sleep: async () => {}, onNotice: () => {} }) };
}

export function validTokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return { access_token: "at_1", refresh_token: "rt_1", expires_at: new Date(Date.now() + 3600_000).toISOString(), ...over };
}
