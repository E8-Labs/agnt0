import { ActivityResponse, routes, TicketList } from "@agnt0/protocol";
import { execa } from "execa";
import pc from "picocolors";
import type { ApiClient } from "../api/client.js";
import { debug } from "../config.js";

export interface CompletionSummary {
  ticketsDone: number;
  ticketsTotal: number;
  credits: number;
  branches: string[];
}

/** Local `agnt0/*` branches not yet merged into the current HEAD. */
export async function unmergedAgentBranches(repoRoot: string): Promise<string[]> {
  const head = await execa("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repoRoot, reject: false });
  const args = ["for-each-ref", "--format=%(refname:short)", ...(head.exitCode === 0 ? ["--no-merged=HEAD"] : []), "refs/heads/agnt0/"];
  const r = await execa("git", args, { cwd: repoRoot, reject: false });
  return r.exitCode === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export async function collectCompletionSummary(api: ApiClient, projectId: string, repoRoot: string, creditsThisRun: number): Promise<CompletionSummary> {
  const [tickets, activity, branches] = await Promise.all([
    api.get(routes.tickets(projectId), { schema: TicketList }).then((t) => t.tickets),
    api.get(`${routes.activity(projectId)}?limit=200`, { schema: ActivityResponse }).catch((e) => {
      debug("activity failed", e);
      return null;
    }),
    unmergedAgentBranches(repoRoot),
  ]);
  const ticketBranches = new Set(tickets.map((t) => `agnt0/${t.id}`));
  const credits = activity ? activity.steps.reduce((sum, s) => sum + s.credits_charged, 0) : creditsThisRun;
  return {
    ticketsDone: tickets.filter((t) => t.status === "done").length,
    ticketsTotal: tickets.length,
    credits: Math.max(credits, creditsThisRun),
    // Ticket branches first, in ticket order; other agnt0/* leftovers after.
    branches: [...branches.filter((b) => ticketBranches.has(b)), ...branches.filter((b) => !ticketBranches.has(b))],
  };
}

export function formatCompletionSummary(s: CompletionSummary): string {
  const credits = `${s.credits.toLocaleString()} credit${s.credits === 1 ? "" : "s"} used`;
  const shown = s.branches.slice(0, 4).join(", ");
  const more = s.branches.length > 4 ? ` +${s.branches.length - 4} more` : "";
  const branches = s.branches.length
    ? `${s.branches.length} branch${s.branches.length === 1 ? "" : "es"} to merge: ${shown}${more}`
    : "no branches left to merge";
  return `${pc.green("✓")} ${pc.bold(`All ${s.ticketsDone} ticket${s.ticketsDone === 1 ? "" : "s"} done`)} · ${credits} · ${branches}`;
}
