import { routes, TokenResponse } from "@agnt0/protocol";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { debug } from "../config.js";
import { ApiClient, realSleep, type TokenProvider } from "../api/client.js";
import type { StoredTokens, TokenStore } from "./store.js";

export function tokensFromResponse(t: TokenResponse, email?: string, now = Date.now()): StoredTokens {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(now + t.expires_in_s * 1000).toISOString(),
    ...(email ? { email } : {}),
  };
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Cross-process mutex (mkdir is atomic). Two `agnt0` processes (say `run` and `watch`) can hit an
 * expired token at the same moment; refresh tokens rotate, so only one of them may spend it.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, sleep = realSleep): Promise<T> {
  const started = Date.now();
  let held = false;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }).catch(() => {});
  while (!held) {
    try {
      await mkdir(path);
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        debug("lock unavailable, continuing without it", e);
        break;
      }
      try {
        const s = await stat(path);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between mkdir and stat
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        debug("lock wait timed out, continuing without it");
        break;
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

export interface AuthSessionOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Directory for the refresh lock (default: AGNT0_HOME or ~/.agnt0). */
  lockDir?: string;
}

/**
 * Token source for the API client. `AGNT0_TOKEN` (CI) wins over stored tokens and is never refreshed.
 *
 * Refresh is safe across processes: it takes a file lock, re-reads the stored credentials, and if
 * another process already replaced the token that failed, it simply uses the new one. Rotated pairs
 * are persisted immediately.
 */
export class AuthSession implements TokenProvider {
  private inflight: Promise<string | null> | null = null;
  private readonly authless: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly lockPath: string;

  constructor(
    private readonly store: TokenStore,
    private readonly apiUrl: string,
    fetchOrOpts?: typeof fetch | AuthSessionOptions,
    env?: NodeJS.ProcessEnv,
  ) {
    const opts: AuthSessionOptions = typeof fetchOrOpts === "function" ? { fetch: fetchOrOpts, env } : { ...(fetchOrOpts ?? {}), ...(env ? { env } : {}) };
    this.env = opts.env ?? process.env;
    this.authless = new ApiClient({ baseUrl: apiUrl, fetch: opts.fetch, tokens: null });
    const dir = opts.lockDir ?? this.env.AGNT0_HOME ?? join(homedir(), ".agnt0");
    this.lockPath = join(dir, "refresh.lock");
  }

  get usingEnvToken(): boolean {
    return Boolean(this.env.AGNT0_TOKEN);
  }

  async hasCredentials(): Promise<boolean> {
    return this.usingEnvToken || (await this.store.load(this.apiUrl)) !== null;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.env.AGNT0_TOKEN) return this.env.AGNT0_TOKEN;
    const t = await this.store.load(this.apiUrl);
    if (!t) return null;
    // Proactively refresh an access token that has already expired (saves a round trip).
    if (Date.parse(t.expires_at) <= Date.now() + 5000) {
      return (await this.refresh(t.access_token)) ?? t.access_token;
    }
    return t.access_token;
  }

  /** The stored token if it is no longer `failed` (another process refreshed meanwhile). */
  async reloadIfChanged(failed: string | undefined): Promise<string | null> {
    if (this.env.AGNT0_TOKEN || !failed) return null;
    const cur = await this.store.load(this.apiUrl);
    return cur && cur.access_token !== failed ? cur.access_token : null;
  }

  /**
   * Returns a usable access token after `failed` stopped working, or null when the user must log in.
   * Concurrent calls in one process share a single attempt; other processes are held off by the lock.
   */
  refresh(failed?: string): Promise<string | null> {
    if (this.env.AGNT0_TOKEN) return Promise.resolve(null);
    this.inflight ??= withFileLock(this.lockPath, () => this.doRefresh(failed)).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(failed: string | undefined): Promise<string | null> {
    const current = await this.store.load(this.apiUrl);
    if (!current?.refresh_token) return null;
    // Someone else already rotated the pair while we waited for the lock.
    if (failed && current.access_token !== failed && Date.parse(current.expires_at) > Date.now() + 5000) {
      debug("using token refreshed by another process");
      return current.access_token;
    }
    try {
      const res = await this.authless.post(routes.token, {
        auth: false,
        body: { grant_type: "refresh_token", refresh_token: current.refresh_token },
        schema: TokenResponse,
      });
      await this.store.save(this.apiUrl, tokensFromResponse(res, current.email));
      return res.access_token;
    } catch (e) {
      debug("refresh failed", e);
      // A process without the lock (older agnt0, a timed-out wait) may have rotated it under us.
      const after = await this.store.load(this.apiUrl);
      if (after && after.refresh_token !== current.refresh_token) return after.access_token;
      return null;
    }
  }
}
