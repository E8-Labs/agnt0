import { Me, routes, type DeviceStartResponse } from "@agnt0/protocol";
import pc from "picocolors";
import { deviceLogin } from "../auth/device.js";
import { tokensFromResponse } from "../auth/session.js";
import { ApiClient } from "../api/client.js";
import { openBrowser } from "../browser.js";
import type { Context } from "../context.js";

export interface LoginOptions {
  browser?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function renderUserCode(code: string): string[] {
  const inner = `  ${code.split("").join(" ")}  `;
  const bar = "─".repeat(inner.length);
  return [`  ┌${bar}┐`, `  │${pc.bold(pc.cyan(inner))}│`, `  └${bar}┘`];
}

/** Only open links that are http(s) and on the configured web app's origin. */
export function isTrustedVerificationUrl(url: string, webUrl: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === new URL(webUrl).origin;
  } catch {
    return false;
  }
}

export async function loginCommand(ctx: Context, opts: LoginOptions = {}): Promise<{ email: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  if (process.env.AGNT0_TOKEN) log(pc.yellow("! AGNT0_TOKEN is set; it overrides the login stored by this command."));

  const authless = new ApiClient({ baseUrl: ctx.apiUrl, tokens: null, sleep: opts.sleep });
  const tokens = await deviceLogin({
    api: authless,
    sleep: opts.sleep,
    onCode: async (s: DeviceStartResponse) => {
      log("");
      log(pc.bold("Sign in to Agent Zero"));
      log("");
      log("Confirm this code in your browser:");
      for (const l of renderUserCode(s.user_code)) log(l);
      // Plain copy for copy-paste and grep.
      log(`Code: ${s.user_code}`);
      log("");
      const trusted = isTrustedVerificationUrl(s.verification_uri_complete, ctx.webUrl);
      if (!trusted) {
        log(pc.yellow(`! The API sent a sign-in link that isn't on ${ctx.webUrl}, so agnt0 won't open it.`));
        log(pc.yellow(`  Only continue if you trust it, or set AGNT0_WEB_URL to the right web app.`));
      }
      const opened = trusted && opts.browser !== false && (await openBrowser(s.verification_uri_complete));
      log(`${opened ? "Opened" : "Open"} ${pc.underline(s.verification_uri_complete)}`);
      if (!opened && isTrustedVerificationUrl(s.verification_uri, ctx.webUrl)) log(pc.dim(`  (or go to ${s.verification_uri} and enter the code)`));
      log(pc.dim("Waiting for approval…"));
    },
  });

  await ctx.store.save(ctx.apiUrl, tokensFromResponse(tokens));
  const api = new ApiClient({ baseUrl: ctx.apiUrl, tokens: { getAccessToken: async () => tokens.access_token, refresh: async () => null } });
  const me = await api.get(routes.me, { schema: Me });
  await ctx.store.save(ctx.apiUrl, tokensFromResponse(tokens, me.email));
  log(`${pc.green("✓")} Logged in as ${pc.bold(me.email)}`);
  if (me.usage.plan === "none") log(pc.dim(`  No plan yet. Pick one with \`agnt0 upgrade\` (${ctx.webUrl}/plans).`));
  else log(pc.dim("  Next: `agnt0 doctor`, then `agnt0 init` or `agnt0 link`."));
  return { email: me.email };
}
