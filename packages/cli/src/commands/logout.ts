import { routes } from "@agnt0/protocol";
import pc from "picocolors";
import { ApiClient } from "../api/client.js";
import { debug } from "../config.js";
import type { Context } from "../context.js";
import { clearCachedMe } from "./status.js";

export async function logoutCommand(ctx: Context, log: (l: string) => void = console.log): Promise<void> {
  const stored = await ctx.store.load(ctx.apiUrl);
  if (stored?.refresh_token) {
    try {
      const api = new ApiClient({ baseUrl: ctx.apiUrl, tokens: null });
      await api.post(routes.revoke, { auth: false, body: { refresh_token: stored.refresh_token } });
    } catch (e) {
      debug("revoke failed", e);
    }
  }
  await ctx.store.clear(ctx.apiUrl);
  await clearCachedMe();
  log(stored ? `${pc.green("✓")} Logged out${stored.email ? ` (${stored.email})` : ""}.` : "You weren't logged in.");
  if (process.env.AGNT0_TOKEN) log(pc.yellow("! AGNT0_TOKEN is still set in your environment."));
}
