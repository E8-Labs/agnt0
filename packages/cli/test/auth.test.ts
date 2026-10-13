import { CLI_VERSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION, routes } from "@agnt0/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient } from "../src/api/client.js";
import { deviceLogin } from "../src/auth/device.js";
import { AuthSession } from "../src/auth/session.js";
import { DefaultTokenStore, FileTokenStore, MemoryTokenStore } from "../src/auth/store.js";
import { loginCommand } from "../src/commands/login.js";
import { CliError } from "../src/errors.js";
import { captureLog, makeCtx, me, startMockApi, tempDir, validTokens, type MockApi } from "./helpers.js";
import { stat } from "node:fs/promises";

let api: MockApi;
beforeEach(async () => {
  api = await startMockApi();
});
afterEach(async () => {
  await api.close();
});

const deviceStart = {
  device_code: "dev_123",
  user_code: "ABCD-EFGH",
  verification_uri: "http://web.test/cli/device",
  verification_uri_complete: "http://web.test/cli/device?code=ABCD-EFGH",
  interval_s: 2,
  expires_in_s: 600,
};
const tokenResponse = { access_token: "at_new", refresh_token: "rt_new", expires_in_s: 900, token_type: "Bearer" };

describe("device login", () => {
  it("polls through pending and slow_down until a token arrives", async () => {
    api.on("POST", routes.deviceStart, () => ({ body: deviceStart }));
    const answers = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: tokenResponse },
    ];
    api.on("POST", routes.token, () => answers.shift());

    const sleeps: number[] = [];
    let shown: string | null = null;
    const client = new ApiClient({ baseUrl: api.url, tokens: null });
    const res = await deviceLogin({
      api: client,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onCode: (s) => {
        shown = s.user_code;
      },
      deviceName: "test-host",
      os: "linux test",
    });

    expect(res.access_token).toBe("at_new");
    expect(shown).toBe("ABCD-EFGH");
    // interval 2s, then +5s after slow_down
    expect(sleeps).toEqual([2000, 2000, 7000, 7000]);
    const start = api.requests.find((r) => r.path === routes.deviceStart)!;
    expect(start.body).toEqual({ client: "agnt0-cli", device_name: "test-host", os: "linux test" });
    expect(start.headers[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));
    expect(start.headers[CLI_VERSION_HEADER]).toMatch(/^\d+\.\d+\.\d+/);
    const polls = api.requests.filter((r) => r.path === routes.token);
    expect(polls).toHaveLength(4);
    expect(polls[0]!.body).toEqual({ grant_type: "device_code", device_code: "dev_123" });
  });

  it("stops with a friendly error when the user denies access", async () => {
    api.on("POST", routes.deviceStart, () => ({ body: deviceStart }));
    api.on("POST", routes.token, () => ({ status: 400, body: { error: "access_denied" } }));
    const client = new ApiClient({ baseUrl: api.url, tokens: null });
    await expect(deviceLogin({ api: client, sleep: async () => {}, onCode: () => {} })).rejects.toThrow(/denied/);
  });

  it("gives up when the code expires", async () => {
    api.on("POST", routes.deviceStart, () => ({ body: { ...deviceStart, expires_in_s: 3 } }));
    api.on("POST", routes.token, () => ({ status: 400, body: { error: "authorization_pending" } }));
    let t = 0;
    const client = new ApiClient({ baseUrl: api.url, tokens: null });
    await expect(
      deviceLogin({ api: client, now: () => t, sleep: async (ms) => void (t += ms), onCode: () => {} }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("login command stores tokens and greets the user by email", async () => {
    api.on("POST", routes.deviceStart, () => ({ body: { ...deviceStart, interval_s: 1 } }));
    api.on("POST", routes.token, () => ({ body: tokenResponse }));
    api.on("GET", routes.me, (r) => (r.headers.authorization === "Bearer at_new" ? { body: me() } : { status: 401, body: { error: "unauthorized", message: "no" } }));
    const ctx = makeCtx(api.url, null);
    const out = captureLog();
    process.env.AGNT0_NO_BROWSER = "1";
    const res = await loginCommand(ctx, { sleep: async () => {}, log: out.log });
    expect(res.email).toBe("noah@example.com");
    expect(out.text()).toContain("Logged in as noah@example.com");
    expect(out.text()).toContain("A B C D - E F G H");
    const saved = ctx.store.data.get(api.url)!;
    expect(saved.access_token).toBe("at_new");
    expect(saved.refresh_token).toBe("rt_new");
    expect(saved.email).toBe("noah@example.com");
  });
});

describe("token refresh", () => {
  it("refreshes once on 401 token_expired, persists the rotated pair and retries", async () => {
    api.on("GET", routes.me, (r) =>
      r.headers.authorization === "Bearer at_fresh" ? { body: me() } : { status: 401, body: { error: "token_expired", message: "expired" } },
    );
    api.on("POST", routes.token, (r) =>
      r.body.grant_type === "refresh_token" && r.body.refresh_token === "rt_old"
        ? { body: { access_token: "at_fresh", refresh_token: "rt_rotated", expires_in_s: 900, token_type: "Bearer" } }
        : { status: 400, body: { error: "bad_request", message: "bad refresh" } },
    );
    const store = new MemoryTokenStore();
    await store.save(api.url, validTokens({ access_token: "at_old", refresh_token: "rt_old", email: "noah@example.com" }));
    const session = new AuthSession(store, api.url, undefined, {});
    const client = new ApiClient({ baseUrl: api.url, tokens: session });

    const res = (await client.get(routes.me)) as { email: string };
    expect(res.email).toBe("noah@example.com");
    const saved = await store.load(api.url);
    expect(saved?.access_token).toBe("at_fresh");
    expect(saved?.refresh_token).toBe("rt_rotated");
    expect(saved?.email).toBe("noah@example.com");
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${routes.me}`, `POST ${routes.token}`, `GET ${routes.me}`]);
  });

  it("asks for login again when the refresh token is rejected", async () => {
    api.on("GET", routes.me, () => ({ status: 401, body: { error: "token_expired", message: "expired" } }));
    api.on("POST", routes.token, () => ({ status: 401, body: { error: "unauthorized", message: "revoked" } }));
    const store = new MemoryTokenStore();
    await store.save(api.url, validTokens());
    const client = new ApiClient({ baseUrl: api.url, tokens: new AuthSession(store, api.url, undefined, {}) });
    await expect(client.get(routes.me)).rejects.toThrow(/expired/);
  });

  it("AGNT0_TOKEN overrides stored tokens and is never refreshed", async () => {
    const store = new MemoryTokenStore();
    await store.save(api.url, validTokens());
    const session = new AuthSession(store, api.url, undefined, { AGNT0_TOKEN: "ci_token" });
    expect(await session.getAccessToken()).toBe("ci_token");
    expect(await session.refresh()).toBeNull();
  });

  it("backs off on 429 honouring retry_after_s", async () => {
    let n = 0;
    api.on("GET", routes.usage, () => (++n === 1 ? { status: 429, body: { error: "rate_limited", message: "slow", retry_after_s: 3 } } : { body: { ok: true } }));
    const waits: number[] = [];
    const notices: string[] = [];
    const client = new ApiClient({ baseUrl: api.url, tokens: { getAccessToken: async () => "t", refresh: async () => null }, sleep: async (ms) => void waits.push(ms), onNotice: (m) => notices.push(m) });
    expect(await client.get(routes.usage)).toEqual({ ok: true });
    expect(waits).toEqual([3000]);
    expect(notices[0]).toMatch(/retrying in 3s/);
  });
});

describe("file token store", () => {
  it("writes credentials.json with mode 0600", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const s = new FileTokenStore(dir);
      await s.save("http://api", validTokens());
      expect((await stat(s.path)).mode & 0o777).toBe(0o600);
      expect((await s.load("http://api"))?.access_token).toBe("at_1");
      await s.clear("http://api");
      expect(await s.load("http://api")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("default store persists across instances when no keychain is usable", async () => {
    const { dir, cleanup } = await tempDir();
    const prev = process.env.AGNT0_NO_KEYRING;
    process.env.AGNT0_NO_KEYRING = "1";
    try {
      await new DefaultTokenStore(dir).save("http://api", validTokens({ email: "a@b.c" }));
      expect((await new DefaultTokenStore(dir).load("http://api"))?.email).toBe("a@b.c");
    } finally {
      if (prev === undefined) delete process.env.AGNT0_NO_KEYRING;
      else process.env.AGNT0_NO_KEYRING = prev;
      await cleanup();
    }
  });
});
