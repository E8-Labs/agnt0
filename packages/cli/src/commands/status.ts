import { Me, Project, routes, type UsageSnapshot } from "@agnt0/protocol";
import pc from "picocolors";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NetworkError } from "../api/client.js";
import { agnt0Home, debug } from "../config.js";
import { type Context, requireLogin } from "../context.js";
import { findProject } from "../project.js";
import { commandVersion } from "../runners/spawn.js";
import { label, table } from "../ui.js";
import { meterCell } from "./usage.js";

const CACHE_TTL_MS = 30 * 60_000;

/** Last good /v1/me, so `status` still says something useful during a network blip (spec: 30 min). */
async function cacheMe(apiUrl: string, me: Me): Promise<void> {
  try {
    const dir = join(agnt0Home(), "cache");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "me.json"), JSON.stringify({ api_url: apiUrl, at: Date.now(), me }), { mode: 0o600 });
  } catch (e) {
    debug("cache write failed", e);
  }
}
export async function clearCachedMe(): Promise<void> {
  await rm(join(agnt0Home(), "cache", "me.json"), { force: true });
}

async function cachedMe(apiUrl: string): Promise<Me | null> {
  try {
    const c = JSON.parse(await readFile(join(agnt0Home(), "cache", "me.json"), "utf8")) as { api_url: string; at: number; me: unknown };
    if (c.api_url !== apiUrl || Date.now() - c.at > CACHE_TTL_MS) return null;
    const p = Me.safeParse(c.me);
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

function planLine(u: UsageSnapshot): string {
  if (u.plan === "none") return pc.yellow("none");
  const status = u.subscription_status === "active" ? pc.green("active") : pc.yellow(u.subscription_status.replace("_", " "));
  return `${u.plan[0]?.toUpperCase()}${u.plan.slice(1)} (${status}) · all agents, up to ${u.max_parallel_agents} at once`;
}

export async function statusCommand(ctx: Context, opts: { json?: boolean } = {}, log: (l: string) => void = console.log): Promise<void> {
  await requireLogin(ctx);
  let me: Me;
  let offline = false;
  try {
    me = await ctx.api.get(routes.me, { schema: Me });
    await cacheMe(ctx.apiUrl, me);
  } catch (e) {
    const cached = e instanceof NetworkError ? await cachedMe(ctx.apiUrl) : null;
    if (!cached) throw e;
    me = cached;
    offline = true;
  }

  const linked = await findProject();
  let project: Project | null = null;
  if (linked && !offline) {
    try {
      project = await ctx.api.get(routes.project(linked.project_id), { schema: Project });
    } catch (e) {
      debug("project fetch failed", e);
    }
  }
  const [claudeV, codexV] = await Promise.all([
    commandVersion(process.env.AGNT0_CLAUDE_BIN ?? "claude"),
    commandVersion(process.env.AGNT0_CODEX_BIN ?? "codex"),
  ]);

  if (opts.json) {
    log(JSON.stringify({ api_url: ctx.apiUrl, offline, me, project_link: linked, project, runners: { claude: claudeV, codex: codexV } }, null, 2));
    return;
  }

  const u = me.usage;
  const projectLine = linked
    ? `${project ? `${pc.bold(project.name)} · ${project.phase.replace("_", " ")}` : linked.name ?? ""} ${pc.dim(`(${linked.project_id})`)}`.trim()
    : pc.dim("not linked here · run `agnt0 init` or `agnt0 link`");
  const runners = [
    claudeV ? `${pc.green("✓")} Claude Code ${claudeV.replace(/\s*\(Claude Code\)/, "")}` : `${pc.red("✗")} Claude Code`,
    codexV ? `${pc.green("✓")} Codex ${codexV}` : pc.dim("Codex not installed"),
  ].join("  ");

  log(`${pc.bold("Agent Zero")} ${pc.dim(`· ${me.email}${me.name ? ` (${me.name})` : ""}`)}${offline ? pc.yellow("  offline · cached") : ""}`);
  log("");
  log(
    table([
      [label("Plan"), planLine(u)],
      [label("Session (5h)"), meterCell(u.session)],
      [label("Week"), meterCell(u.week)],
      [label("Extra credits"), `${u.wallet.balance} credits · keep working ${u.wallet.keep_working ? "on" : "off"}`],
      [label("Project"), projectLine],
      [label("API"), `${offline ? pc.yellow("unreachable") : pc.green("connected")} ${pc.dim(ctx.apiUrl)} · ${me.cli_sessions.length} CLI session(s)`],
      [label("Runners"), runners],
    ]),
  );
  if (u.plan === "none" || u.subscription_status === "lapsed" || u.subscription_status === "canceled") {
    log("");
    log(`${pc.yellow("!")} No active plan, so builds can't run. Pick one: ${pc.cyan("agnt0 upgrade")} (${ctx.webUrl}/plans)`);
  } else if (u.subscription_status === "past_due") {
    log("");
    log(`${pc.yellow("!")} Your last payment failed. Update your card at ${ctx.webUrl}/plans to keep building.`);
  }
}
