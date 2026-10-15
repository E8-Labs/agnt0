import { CLI_VERSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION } from "@agnt0/protocol";
import type { ZodType, ZodTypeDef } from "zod";
import { debug } from "../config.js";
import { ApiHttpError, CliError } from "../errors.js";
import { CLI_VERSION } from "../version.js";

/** Supplies bearer tokens to the client and refreshes them when the API says they expired. */
export interface TokenProvider {
  getAccessToken(): Promise<string | null>;
  /** Returns a fresh access token, or null when refresh is impossible. */
  refresh(): Promise<string | null>;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokens?: TokenProvider | null;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** One-line notices for the user, e.g. rate-limit backoff. */
  onNotice?: (message: string) => void;
  max429Retries?: number;
}

export interface RequestOptions<T> {
  body?: unknown;
  schema?: ZodType<T, ZodTypeDef, unknown>;
  /** Defaults to true. Auth endpoints pass false. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Overrides the client's 429 retry budget for this call (0 = fail fast). */
  max429Retries?: number;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), [CLI_VERSION_HEADER]: CLI_VERSION };
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly tokens: TokenProvider | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onNotice: (message: string) => void;
  private readonly max429Retries: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokens ?? null;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.onNotice = opts.onNotice ?? ((m) => console.error(m));
    this.max429Retries = opts.max429Retries ?? 6;
  }

  get<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("GET", path, opts);
  }
  post<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("POST", path, opts);
  }
  patch<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("PATCH", path, opts);
  }
  put<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("PUT", path, opts);
  }
  delete<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("DELETE", path, opts);
  }

  async request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const useAuth = opts.auth !== false;
    let token: string | null = null;
    if (useAuth) {
      token = (await this.tokens?.getAccessToken()) ?? null;
      if (!token) throw new CliError("You're not logged in.", "Run `agnt0 login` first.");
    }
    let refreshed = false;
    let rateLimitHits = 0;

    for (;;) {
      const res = await this.send(method, path, opts, token);
      const raw = await readBody(res);

      if (res.ok) {
        if (!opts.schema) return raw as T;
        const parsed = opts.schema.safeParse(raw);
        if (!parsed.success) {
          debug("schema mismatch", path, parsed.error.issues);
          throw new CliError(
            `The Agent Zero API sent a response this CLI doesn't understand (${method} ${path}).`,
            "Update agnt0 (npm i -g agnt0@latest), or set DEBUG=agnt0 for details.",
          );
        }
        return parsed.data;
      }

      const err = new ApiHttpError(res.status, raw, path);

      if (res.status === 401 && useAuth && !refreshed && err.code === "token_expired" && this.tokens) {
        refreshed = true;
        const next = await this.tokens.refresh();
        if (next) {
          token = next;
          continue;
        }
        throw new CliError("Your Agent Zero session has expired.", "Run `agnt0 login` again.");
      }

      if (res.status === 429 && rateLimitHits < (opts.max429Retries ?? this.max429Retries)) {
        rateLimitHits++;
        const header = Number(res.headers.get("retry-after"));
        const wait = err.body?.retry_after_s ?? (Number.isFinite(header) && header > 0 ? header : 2 ** rateLimitHits);
        this.onNotice(`Rate limited by Agent Zero; retrying in ${Math.ceil(wait)}s…`);
        await this.sleep(Math.ceil(wait * 1000));
        continue;
      }

      if (res.status === 426 || err.code === "protocol_outdated") {
        throw new CliError(
          `This version of agnt0 is too old for the Agent Zero API.`,
          "Update it: npm i -g agnt0@latest",
        );
      }
      throw err;
    }
  }

  private async send(method: string, path: string, opts: RequestOptions<unknown>, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...protocolHeaders() };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      debug("network error", method, path, e);
      throw new NetworkError(this.baseUrl);
    }
  }
}

export class NetworkError extends CliError {
  constructor(baseUrl: string) {
    super(`Can't reach the Agent Zero API at ${baseUrl}.`, "Check your connection, or point agnt0 elsewhere with --api <url> / AGNT0_API_URL.");
    this.name = "NetworkError";
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
