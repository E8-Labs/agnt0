import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "http://localhost:8787";
export const DEFAULT_WEB_URL = "http://localhost:3000";

let apiOverride: string | undefined;

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
