/**
 * `agnt0 share` — a temporary public link to the preview running on this machine.
 *
 * The tunnel is Cloudflare's quick tunnel, run as a child process: no account, no DNS, no config, and
 * nothing of ours in the path of the traffic. We only record the address so the dashboard can show
 * what is live and revoke it.
 *
 * Two things this command is careful about, because it makes a private thing public:
 *  - It says what it is about to expose, and to whom, before it does it.
 *  - Ctrl-C closes the tunnel *and* revokes the link, so a stale address never sits on the dashboard
 *    pointing at a machine that has moved on.
 */
import { execa, type ResultPromise } from "execa";
import pc from "picocolors";
import { ShareLink, ShareLinkList, m2routes } from "@agnt0/protocol";
import { debug } from "../config.js";
import type { Context } from "../context.js";
import { requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { httpUp } from "../net.js";
import { findProject } from "../project.js";
import { relTime, sym, table } from "../ui.js";

export interface ShareOptions {
  url?: string;
  port?: string;
  ttl?: string;
  label?: string;
  list?: boolean;
  revoke?: string;
}

const CLOUDFLARED_HELP = [
  "Install cloudflared, which runs the tunnel on your machine:",
  "  macOS    brew install cloudflared",
  "  Linux    see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  "  Windows  winget install Cloudflare.cloudflared",
].join("\n");

/** cloudflared prints the address it got on stderr, once, in a box. */
const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

async function haveCloudflared(): Promise<boolean> {
  try {
    const r = await execa("cloudflared", ["--version"], { reject: false, timeout: 10_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Starts the tunnel and resolves with its public address, or throws with what cloudflared said. */
function openTunnel(target: string, onLine?: (l: string) => void): { url: Promise<string>; proc: ResultPromise } {
  const proc = execa("cloudflared", ["tunnel", "--no-autoupdate", "--url", target], { reject: false, all: true });
  const url = new Promise<string>((resolve, reject) => {
    let settled = false;
    const tail: string[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new CliError("cloudflared did not produce a link within 60 seconds.", tail.slice(-3).join("\n") || "Check your connection and try again."));
    }, 60_000);
    proc.all?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        tail.push(line.trim());
        onLine?.(line.trim());
        const m = TRYCLOUDFLARE.exec(line);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(m[0]);
        }
      }
    });
    void proc.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliError("cloudflared stopped before it gave us a link.", tail.slice(-3).join("\n")));
    });
  });
  return { url, proc };
}

export async function shareCommand(ctx: Context, opts: ShareOptions): Promise<void> {
  await requireLogin(ctx);
  const project = await findProject(process.cwd());
  if (!project) throw new CliError("This folder isn't linked to an Agent Zero project.", "Run `agnt0 init` or `agnt0 link` first.");

  if (opts.list) {
    const { links } = await ctx.api.get(m2routes.shareLinks(project.project_id), { schema: ShareLinkList });
    const live = links.filter((l) => l.status === "active");
    if (!live.length) {
      console.log("No live share links. Open one with `agnt0 share`.");
      return;
    }
    console.log(table([[pc.dim("LINK"), pc.dim("LABEL"), pc.dim("EXPIRES")], ...live.map((l) => [l.url, l.label ?? pc.dim("—"), relTime(l.expires_at)])]));
    return;
  }

  if (opts.revoke) {
    const { links } = await ctx.api.get(m2routes.shareLinks(project.project_id), { schema: ShareLinkList });
    const match = links.find((l) => l.id === opts.revoke || l.url === opts.revoke);
    if (!match) throw new CliError(`No share link matching ${JSON.stringify(opts.revoke)}.`, "List them with `agnt0 share --list`.");
    await ctx.api.delete(m2routes.shareLink(match.id));
    console.log(`${sym.ok} Revoked ${match.url}.`);
    return;
  }

  const port = opts.port ? Number(opts.port) : 5173;
  const target = opts.url ?? `http://localhost:${port}`;
  if (!/^https?:\/\//.test(target)) throw new CliError(`${target} isn't a URL.`, "Pass something like --url http://localhost:3000.");

  if (!(await haveCloudflared())) {
    throw new CliError("`agnt0 share` needs cloudflared, and it isn't on this machine.", CLOUDFLARED_HELP);
  }
  if (!(await httpUp(target, 2500))) {
    throw new CliError(`Nothing is answering at ${target}.`, "Start your app first (`agnt0 preview`), or point at it with --url.");
  }

  // Said plainly before anything is exposed: this is the moment a private thing becomes public.
  console.log(`Opening a public link to ${pc.bold(target)} on this machine.`);
  console.log(pc.dim("Anyone with the address can reach it while this runs. Ctrl-C closes it.\n"));

  const { url, proc } = openTunnel(target, (l) => debug("cloudflared", l));
  const publicUrl = await url;

  let link: ShareLink | null = null;
  try {
    link = await ctx.api.post(m2routes.shareLinks(project.project_id), {
      body: { url: publicUrl, kind: "tunnel", ...(opts.label ? { label: opts.label } : {}), ...(opts.ttl ? { ttl_hours: Number(opts.ttl) } : {}) },
      schema: ShareLink,
    });
  } catch (e) {
    // The tunnel is open either way; a failed record must not leave the user without the address.
    console.log(`${sym.warn} The link is live but Agent Zero didn't record it, so it won't be on the dashboard.`);
    debug("share register failed", e);
  }

  console.log(`${sym.ok} ${pc.bold(publicUrl)}`);
  if (link) console.log(pc.dim(`  expires ${relTime(link.expires_at)} · revoke from the dashboard or with \`agnt0 share --revoke ${link.id}\``));
  console.log(pc.dim("  Ctrl-C to close it.\n"));

  const close = async () => {
    proc.kill();
    if (link) {
      try {
        await ctx.api.delete(m2routes.shareLink(link.id));
      } catch (e) {
        debug("share revoke failed", e);
      }
    }
    console.log(`\n${sym.ok} Closed. The link no longer works.`);
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  await proc;
  await close();
}
