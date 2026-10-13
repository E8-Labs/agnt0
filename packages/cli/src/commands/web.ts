import { routes, UsageSnapshot } from "@agnt0/protocol";
import pc from "picocolors";
import { openBrowser } from "../browser.js";
import { type Context, requireLogin } from "../context.js";
import { requireProject } from "../project.js";

async function openAndPrint(url: string, what: string, log: (l: string) => void): Promise<void> {
  const opened = await openBrowser(url);
  log(opened ? `Opened ${what}: ${pc.underline(url)}` : `${what}: ${pc.underline(url)}`);
}

export async function openCommand(ctx: Context, log: (l: string) => void = console.log): Promise<string> {
  const p = await requireProject();
  const url = `${ctx.webUrl}/p/${encodeURIComponent(p.project_id)}`;
  await openAndPrint(url, "the dashboard", log);
  return url;
}

export async function creditsUseCommand(ctx: Context, opts: { off?: boolean } = {}, log: (l: string) => void = console.log): Promise<void> {
  await requireLogin(ctx);
  const keep = !opts.off;
  const res = await ctx.api.patch(routes.usageSettings, { body: { keep_working: keep } });
  const snap = UsageSnapshot.safeParse(res);
  if (keep) {
    log(`${pc.green("✓")} Keep working with extra credits is ${pc.bold("on")}.`);
    if (snap.success) {
      log(pc.dim(`  Wallet: ${snap.data.wallet.balance} credits.`));
      if (snap.data.wallet.balance <= 0) log(`${pc.yellow("!")} Your wallet is empty. Top up with ${pc.cyan("agnt0 credits buy")}.`);
    }
    log(pc.dim("  A paused `agnt0 run --watch` picks up on its own; otherwise run `agnt0 run` again."));
  } else {
    log(`${pc.green("✓")} Keep working with extra credits is ${pc.bold("off")}.`);
  }
}

export async function creditsBuyCommand(ctx: Context, log: (l: string) => void = console.log): Promise<string> {
  const url = `${ctx.webUrl}/usage?buy=1`;
  await openAndPrint(url, "credit packs", log);
  return url;
}

export async function upgradeCommand(ctx: Context, log: (l: string) => void = console.log): Promise<string> {
  const url = `${ctx.webUrl}/plans`;
  await openAndPrint(url, "plans", log);
  return url;
}
