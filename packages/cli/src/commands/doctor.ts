import { routes } from "@agnt0/protocol";
import pc from "picocolors";
import { debug } from "../config.js";
import type { Context } from "../context.js";
import { CHECK_LABELS, runDoctorChecks, type DoctorResult } from "../doctor.js";
import { table } from "../ui.js";

export function renderDoctor(r: DoctorResult): string {
  const rows = r.report.checks.map((c) => {
    const icon = c.ok ? pc.green("✓") : r.optional.has(c.id) ? pc.yellow("!") : pc.red("✗");
    return [icon, CHECK_LABELS[c.id], c.ok ? pc.dim(c.detail) : c.detail];
  });
  const fixes = Object.entries(r.fixes)
    .filter(([id]) => !r.optional.has(id as never) || id === "ports")
    .map(([id, fix]) => `  ${pc.dim("•")} ${CHECK_LABELS[id as keyof typeof CHECK_LABELS]}: ${fix}`);
  const out = [table(rows)];
  if (fixes.length) out.push("", pc.bold("To fix"), ...fixes);
  out.push("", r.ready ? `${pc.green("✓")} Ready to build.` : `${pc.red("✗")} Not ready yet: fix the items above, then run \`agnt0 doctor\` again.`);
  return out.join("\n");
}

export async function doctorCommand(
  ctx: Context,
  opts: { json?: boolean; upload?: boolean } = {},
  log: (l: string) => void = console.log,
  run: () => Promise<DoctorResult> = runDoctorChecks,
): Promise<DoctorResult> {
  const result = await run();
  let uploaded = false;
  if (opts.upload !== false && (await ctx.session.hasCredentials())) {
    try {
      await ctx.api.post(routes.doctorReports, { body: result.report });
      uploaded = true;
    } catch (e) {
      debug("doctor upload failed", e);
    }
  }
  if (opts.json) {
    log(JSON.stringify(result.report, null, 2));
  } else {
    log(pc.bold("agnt0 doctor"));
    log("");
    log(renderDoctor(result));
    if (uploaded) log(pc.dim("  Report sent to your Agent Zero account."));
  }
  if (!result.ready) process.exitCode = 1;
  return result;
}
