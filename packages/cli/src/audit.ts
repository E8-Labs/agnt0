import { AuditList, m2routes, type AuditRun } from "@agnt0/protocol";
import pc from "picocolors";
import type { ApiClient } from "./api/client.js";
import { debug } from "./config.js";

/** The audit waiting for a runner (queued, or leased and running), newest first. */
export async function pendingAudit(api: ApiClient, projectId: string): Promise<AuditRun | null> {
  try {
    const { audits } = await api.get(m2routes.audits(projectId), { schema: AuditList });
    return audits.find((a) => a.status === "queued" || a.status === "running") ?? null;
  } catch (e) {
    debug("audit list failed", e);
    return null;
  }
}

/** Printed after `agnt0 link` when the API queued the Code Auditor for the newly linked repo. */
export async function auditQueuedLines(api: ApiClient, projectId: string): Promise<string[]> {
  const a = await pendingAudit(api, projectId);
  if (!a) return [];
  return [
    `  ${pc.cyan("◆")} The Code Auditor is queued ${pc.dim(`(${a.mode} · est. ~${a.estimate_credits} credits)`)}: it audits what's already in this repo and runs first,`,
    `    before the Planner writes any tickets. It starts with ${pc.cyan("agnt0 run")} ${pc.dim("· skip it with agnt0 audit --skip")}`,
  ];
}
