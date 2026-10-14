import { m2routes, QaRunCreated, QaRunDetail, type QaRun, type SignedUpload } from "@agnt0/protocol";
import pc from "picocolors";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { debug } from "../config.js";
import { type Context, requireLogin } from "../context.js";
import { forDevServer, loadDevEnv } from "../env.js";
import { ApiHttpError, CliError } from "../errors.js";
import { ensureExcluded, headSha } from "../git.js";
import { attachDevServer, startDevServer, type DevServer } from "../preview/devserver.js";
import { readLivePreview } from "../preview/session.js";
import { requireProject } from "../project.js";
import { isInteractive, ttyAsk, type Ask } from "../prompt.js";
import { ensureChromium } from "../qa/chromium.js";
import { QA_VIEWPORTS, runQaPass, type QaDevice, type QaLocalFinding, type QaShot } from "../qa/runner.js";
import { pauseMessage } from "../run/limits.js";
import { table, truncate } from "../ui.js";

export interface QaOptions {
  devices?: string;
  pages?: string;
  url?: string;
  yes?: boolean;
}

export type QaExit =
  | { status: "completed"; run: QaRun; findings: QaLocalFinding[]; shots: QaShot[]; uploaded: number }
  | { status: "paused"; code: string };

const ALL_DEVICES: QaDevice[] = ["mobile", "tablet", "desktop"];

export function parseDevices(s: string | undefined): QaDevice[] {
  if (!s) return ALL_DEVICES;
  const list = [...new Set(s.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((d) => !(ALL_DEVICES as string[]).includes(d));
  if (bad.length || !list.length) throw new CliError(`Unknown device${bad.length === 1 ? "" : "s"}: ${bad.join(", ") || s}.`, "Use any of: mobile, tablet, desktop.");
  return list as QaDevice[];
}

export function parsePages(s: string | undefined): string[] {
  if (!s) return ["/"];
  const list = [...new Set(s.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`)))];
  if (list.length > 50) throw new CliError("At most 50 pages per QA run.");
  return list.length ? list : ["/"];
}

/** Matches the API's upload key for a device + page index (`…/<device>-<i>.png`), falling back to order. */
export function uploadFor(uploads: SignedUpload[], devices: QaDevice[], pages: string[], device: QaDevice, index: number): SignedUpload | undefined {
  const byKey = uploads.find((u) => u.key.endsWith(`/${device}-${index}.png`));
  if (byKey) return byKey;
  return uploads[devices.indexOf(device) * pages.length + index];
}

async function putBlob(url: string, body: Buffer, contentType: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(body) });
      if (res.ok) return true;
      debug("blob upload failed", res.status, await res.text().catch(() => ""));
      if (res.status < 500) return false;
    } catch (e) {
      debug("blob upload error", e);
    }
  }
  return false;
}

export async function qaCommand(ctx: Context, opts: QaOptions, log: (l: string) => void = console.log, ask: Ask | null = isInteractive() ? ttyAsk : null): Promise<QaExit> {
  await requireLogin(ctx);
  const project = await requireProject();
  const devices = parseDevices(opts.devices);
  const pages = parsePages(opts.pages);
  if (devices.length * pages.length > 200) throw new CliError("At most 200 screenshots per run (devices × pages).");
  await ensureExcluded(project.root);

  log(`${pc.bold("agnt0 qa")} ${pc.dim(`· ${project.name ?? project.project_id} · ${devices.join(", ")} · ${pages.join(", ")}`)}`);

  // 1. Browser first, so nothing is charged if Chromium can't be set up.
  const executablePath = await ensureChromium({ yes: opts.yes, ask, log });

  // 2. The app: --url, a running `agnt0 preview`, or start the dev server ourselves.
  let dev: DevServer | null = null;
  let baseUrl: string;
  if (opts.url) {
    baseUrl = await attachDevServer(opts.url);
  } else {
    const live = await readLivePreview(project.root);
    if (live) {
      baseUrl = live.app_url;
      log(pc.dim(`  using the running preview: ${baseUrl}`));
    } else {
      const env = await loadDevEnv(ctx.api, project.project_id);
      dev = await startDevServer({ root: project.root, env: forDevServer(env) });
      log(pc.dim(`  no preview running; starting ${dev.plan.label} (${dev.plan.file} ${dev.plan.args.join(" ")})`));
      try {
        baseUrl = await dev.ready;
      } catch (e) {
        await dev.stop();
        throw e;
      }
      log(pc.dim(`  app at ${baseUrl}`));
    }
  }

  try {
    // 3. Open the run (charged as a QA step).
    let created: QaRunCreated;
    try {
      created = await ctx.api.post(m2routes.qaRuns(project.project_id), {
        body: { build_sha: await headSha(project.root), devices, base_url: baseUrl, pages },
        schema: QaRunCreated,
      });
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 402) {
        for (const l of pauseMessage(e, ctx.webUrl)) log(l);
        return { status: "paused", code: e.code ?? "payment_required" };
      }
      throw e;
    }
    const run = created.qa_run;
    const outDir = join(project.root, ".agnt0", "qa", run.id);

    // 4. Drive Chromium.
    let pass: Awaited<ReturnType<typeof runQaPass>>;
    try {
      pass = await runQaPass({
        baseUrl,
        pages,
        devices,
        outDir,
        executablePath,
        onProgress: (d, p) => log(pc.dim(`  ${d.padEnd(7)} ${QA_VIEWPORTS[d].width}×${QA_VIEWPORTS[d].height}  ${p}`)),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.api.post(m2routes.qaRunComplete(run.id), { body: { status: "error", screenshots: [], findings: [] } }).catch((err) => debug("qa complete failed", err));
      throw new CliError(`The QA pass failed: ${truncate(msg.split("\n")[0] ?? msg, 300)}`, "Run with DEBUG=agnt0 for details.");
    }

    // 5. Upload screenshots through the signed URLs.
    const keyFor = new Map<string, string>();
    let uploaded = 0;
    for (const shot of pass.shots) {
      const up = uploadFor(created.uploads, devices, pages, shot.device, shot.index);
      if (!up) continue;
      if (await putBlob(up.put_url, await readFile(shot.file), shot.contentType)) {
        keyFor.set(`${shot.device}|${shot.index}`, up.key);
        uploaded++;
      }
    }
    if (uploaded < pass.shots.length) log(pc.yellow(`! ${pass.shots.length - uploaded} screenshot(s) didn't upload; they're still in ${relative(process.cwd(), outDir) || outDir}.`));

    // 6. Report.
    const sevRank = { high: 0, medium: 1, low: 2 } as const;
    const findings = [...pass.findings].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]).slice(0, 100);
    const status = findings.some((f) => f.severity !== "low") ? "failed" : "passed";
    const detail = await ctx.api.post(m2routes.qaRunComplete(run.id), {
      body: {
        status,
        screenshots: pass.shots.flatMap((s) => {
          const key = keyFor.get(`${s.device}|${s.index}`);
          return key ? [{ device: s.device, key, page: s.page }] : [];
        }),
        findings: findings.map((f) => ({
          severity: f.severity,
          device: f.device,
          title: f.title,
          url: f.url,
          repro_steps: f.repro_steps,
          screenshot_key: keyFor.get(`${f.device}|${f.index}`) ?? null,
        })),
      },
      schema: QaRunDetail,
    });

    printSummary(log, { devices, pages, findings: pass.findings, shots: pass.shots, outDir, status });
    const tickets = detail.findings.filter((f) => f.ticket_id).length;
    if (tickets) log(`  ${tickets} finding${tickets === 1 ? "" : "s"} became bug ticket${tickets === 1 ? "" : "s"} on your board.`);
    log(`  ${pc.dim("Results:")} ${ctx.webUrl}/p/${project.project_id}/qa`);
    return { status: "completed", run: detail.qa_run, findings: pass.findings, shots: pass.shots, uploaded };
  } finally {
    await dev?.stop();
  }
}

function printSummary(
  log: (l: string) => void,
  r: { devices: QaDevice[]; pages: string[]; findings: QaLocalFinding[]; shots: QaShot[]; outDir: string; status: "passed" | "failed" },
): void {
  log("");
  const rows: string[][] = [[pc.dim("PAGE"), ...r.devices.map((d) => pc.dim(d.toUpperCase()))]];
  for (const [i, page] of r.pages.entries()) {
    rows.push([
      truncate(page, 40),
      ...r.devices.map((d) => {
        const fs = r.findings.filter((f) => f.device === d && f.index === i);
        if (!fs.length) return pc.green("✓ clean");
        const high = fs.filter((f) => f.severity === "high").length;
        const med = fs.filter((f) => f.severity === "medium").length;
        const color = high ? pc.red : med ? pc.yellow : pc.dim;
        return color(`${fs.length} issue${fs.length === 1 ? "" : "s"}`);
      }),
    ]);
  }
  log(table(rows, 3));
  log("");
  if (r.findings.length) {
    const sevColor = { high: pc.red, medium: pc.yellow, low: pc.dim } as const;
    for (const f of r.findings.slice(0, 15)) log(`  ${sevColor[f.severity](f.severity.padEnd(6))} ${pc.dim(f.device.padEnd(7))} ${truncate(f.title, 100)} ${pc.dim(f.page)}`);
    if (r.findings.length > 15) log(pc.dim(`  …and ${r.findings.length - 15} more on the dashboard`));
    log("");
  }
  const mark = r.status === "passed" ? pc.green("✓") : pc.yellow("!");
  log(`${mark} QA ${r.status === "passed" ? "passed" : "found issues"}: ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"} · ${r.shots.length} screenshot${r.shots.length === 1 ? "" : "s"} ${pc.dim(`(${relative(process.cwd(), r.outDir) || r.outDir})`)}`);
}
