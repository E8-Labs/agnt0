import { routes, UsageSnapshot, type UsageWindow } from "@agnt0/protocol";
import pc from "picocolors";
import { type Context, requireLogin } from "../context.js";
import { clockTime, label, meterBar, percent, relTime, table } from "../ui.js";

export function meterRow(name: string, w: UsageWindow): string[] {
  const reset = w.resets_at ? `resets ${clockTime(w.resets_at)} (${relTime(w.resets_at)})` : pc.dim("not started");
  return [label(name), `${meterBar(w.used, w.allowance)} ${percent(w.used, w.allowance).padStart(4)}`, `${w.used}/${w.allowance} credits`, reset];
}

/** Single-cell variant for two-column tables (status). */
export function meterCell(w: UsageWindow): string {
  const reset = w.resets_at ? `resets ${relTime(w.resets_at)}` : pc.dim("not started");
  return `${meterBar(w.used, w.allowance)} ${percent(w.used, w.allowance)} · ${w.used}/${w.allowance} credits · ${reset}`;
}

export function renderUsage(u: UsageSnapshot): string {
  const rows = [meterRow("Session (5h)", u.session), meterRow("Week", u.week)];
  const hostedPct = u.hosted_ai.cap > 0 ? ` (${percent(u.hosted_ai.used, u.hosted_ai.cap)} of its share)` : "";
  const lines = [
    table(rows),
    "",
    table([
      [label("Hosted AI"), `${u.hosted_ai.used}/${u.hosted_ai.cap} credits${hostedPct}`],
      [label("Setup allowance"), `${u.onboarding_allowance_left} credits left`],
      [label("Extra credits"), `${u.wallet.balance} credits · keep working ${u.wallet.keep_working ? pc.green("on") : pc.dim("off")}`],
      [label("Auto-reload"), u.wallet.auto_reload_pack === "none" ? pc.dim("off") : u.wallet.auto_reload_pack.replace("pack_", "$")],
      [label("Spend cap"), `$${u.wallet.spent_this_month_usd.toFixed(2)} of $${u.wallet.monthly_spend_cap_usd.toFixed(2)} this month`],
    ]),
  ];
  return lines.join("\n");
}

export async function usageCommand(ctx: Context, opts: { json?: boolean } = {}, log: (l: string) => void = console.log): Promise<UsageSnapshot> {
  await requireLogin(ctx);
  const u = await ctx.api.get(routes.usage, { schema: UsageSnapshot });
  if (opts.json) {
    log(JSON.stringify(u, null, 2));
    return u;
  }
  log(`${pc.bold("Usage")} ${pc.dim(`· ${u.plan} plan`)}`);
  log("");
  log(renderUsage(u));
  if (u.plan === "none") log(`\n${pc.yellow("!")} No active plan. Pick one: ${pc.cyan("agnt0 upgrade")} (${ctx.webUrl}/plans)`);
  return u;
}
