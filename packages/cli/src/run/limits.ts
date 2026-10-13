import { LimitReached, type UsageSnapshot } from "@agnt0/protocol";
import pc from "picocolors";
import type { ApiHttpError } from "../errors.js";
import { clockTime, relTime } from "../ui.js";

const LIMIT_NAMES = { session: "5-hour session", week: "weekly", hosted_ai: "hosted-AI" } as const;

/** Lines printed when the API says to stop (402). */
export function pauseMessage(err: ApiHttpError, webUrl: string): string[] {
  const limit = LimitReached.safeParse(err.rawBody);
  if (limit.success) {
    const l = limit.data;
    return [
      `${pc.yellow("⏸")}  ${pc.bold("Paused:")} ${LIMIT_NAMES[l.limit]} limit reached (${l.used}/${l.allowance} credits).`,
      `   Resets ${clockTime(l.resets_at)} (${relTime(l.resets_at)}). Work picks up again after that.`,
      `   Keep going now:`,
      `     ${pc.cyan("agnt0 credits use")}   keep working on extra credits`,
      `     ${pc.cyan("agnt0 upgrade")}       more room every session and week`,
    ];
  }
  if (err.code === "credits_exhausted") {
    return [
      `${pc.yellow("⏸")}  ${pc.bold("Paused:")} your extra credits are used up.`,
      `   Keep going now:`,
      `     ${pc.cyan("agnt0 credits buy")}   top up your wallet${err.body?.upgrade_url ? "" : ` (${webUrl}/usage?buy=1)`}`,
      `     ${pc.cyan("agnt0 upgrade")}       more room every session and week`,
    ];
  }
  // plan_required (or any other 402)
  const url = err.body?.upgrade_url ?? `${webUrl}/plans`;
  return [
    `${pc.yellow("⏸")}  ${pc.bold("Paused:")} this needs an active Agent Zero plan.`,
    `   Pick one: ${pc.cyan("agnt0 upgrade")}  (${url})`,
  ];
}

/** 80% warnings from a usage snapshot, per spec. */
export function usageWarnings(u: UsageSnapshot): string[] {
  const out: string[] = [];
  for (const w of [u.session, u.week]) {
    if (w.allowance > 0 && w.used / w.allowance >= 0.8 && w.used < w.allowance) {
      const name = w.kind === "session" ? "5-hour session" : "weekly";
      out.push(`${pc.yellow("!")} ${Math.round((w.used / w.allowance) * 100)}% of your ${name} limit used; resets ${relTime(w.resets_at)}.`);
    }
  }
  return out;
}
