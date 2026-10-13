import { routes, TokenResponse } from "@agnt0/protocol";
import { debug } from "../config.js";
import { ApiClient, type TokenProvider } from "../api/client.js";
import type { StoredTokens, TokenStore } from "./store.js";

export function tokensFromResponse(t: TokenResponse, email?: string, now = Date.now()): StoredTokens {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(now + t.expires_in_s * 1000).toISOString(),
    ...(email ? { email } : {}),
  };
}

/**
 * Token source for the API client. `AGNT0_TOKEN` (CI) wins over stored tokens and is never refreshed.
 * Refresh tokens rotate on every use, so the new pair is persisted immediately.
 */
export class AuthSession implements TokenProvider {
  private inflight: Promise<string | null> | null = null;
  private readonly authless: ApiClient;

  constructor(
    private readonly store: TokenStore,
    private readonly apiUrl: string,
    fetchImpl?: typeof fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.authless = new ApiClient({ baseUrl: apiUrl, fetch: fetchImpl, tokens: null });
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
      return (await this.refresh()) ?? t.access_token;
    }
    return t.access_token;
  }

  refresh(): Promise<string | null> {
    if (this.env.AGNT0_TOKEN) return Promise.resolve(null);
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string | null> {
    const current = await this.store.load(this.apiUrl);
    if (!current?.refresh_token) return null;
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
      return null;
    }
  }
}
