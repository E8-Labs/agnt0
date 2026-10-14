import { CliError } from "./errors.js";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "http://localhost:8787";
export const DEFAULT_WEB_URL = "http://localhost:3000";

let apiOverride: string | undefined;
let insecureOverride = false;

/** Set by the global `--insecure` flag. */
export function setInsecure(v: boolean): void {
  insecureOverride = v;
}

export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Plain-http API URLs are only allowed for local hosts; anything else would send tokens in the clear.
 * Returns a warning to print (when allowed with --insecure / AGNT0_INSECURE=1) or throws.
 */
export function checkApiUrlSecurity(url: string, insecure = insecureOverride || process.env.AGNT0_INSECURE === "1"): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CliError(`${url} isn't a valid API URL.`, "Use something like https://api.agnt0.dev or http://localhost:8787.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CliError(`${url} isn't an http(s) URL.`);
  if (u.protocol === "https:" || isLocalHost(u.hostname)) return null;
  if (!insecure) {
    throw new CliError(`Refusing to send your Agent Zero credentials over plain http to ${u.host}.`, "Use an https:// API URL, or pass --insecure if you really mean it.");
  }
  return `! Using an insecure http API (${u.host}); your tokens travel unencrypted.`;
}

/** Set by the global `--api <url>` flag. */
export function setApiOverride(url: string | undefined): void {
  apiOverride = url;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getApiUrl(): string {
  return trimSlash(apiOverride ?? process.env.AGNT0_API_URL ?? DEFAULT_API_URL);
}

export function getWebUrl(): string {
  return trimSlash(process.env.AGNT0_WEB_URL ?? DEFAULT_WEB_URL);
}

/** ~/.agnt0, overridable with AGNT0_HOME (used by tests). */
export function agnt0Home(): string {
  return process.env.AGNT0_HOME ?? join(homedir(), ".agnt0");
}

export function isDebug(): boolean {
  const d = process.env.DEBUG ?? "";
  return d === "*" || d.split(",").some((s) => s.trim() === "agnt0" || s.trim() === "agnt0:*");
}

export function debug(...args: unknown[]): void {
  if (isDebug()) console.error("[agnt0]", ...args);
}
