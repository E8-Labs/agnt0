import pc from "picocolors";
import QRCode from "qrcode";
import type { ApiClient } from "../api/client.js";
import { openBrowser } from "../browser.js";
import { debug } from "../config.js";
import type { Context } from "../context.js";
import { forDevServer, loadDevEnv } from "../env.js";
import { CliError, describeError } from "../errors.js";
import { attachDevServer, startDevServer, type DevServer } from "../preview/devserver.js";
import { startPreviewPage, type PreviewPage } from "../preview/page-server.js";
import { removePreviewFile, reportPreview, writePreviewFile } from "../preview/session.js";
import { findProject } from "../project.js";

export interface PreviewOptions {
  browser?: boolean;
  url?: string;
  port?: string;
}

export interface PreviewSession {
  page: PreviewPage;
  dev: DevServer | null;
  appUrl: string;
  framework: string | null;
  /** Resolves when the dev server exits on its own (never for --url). */
  devExit: Promise<number | null>;
  stop(reason?: "stopped" | "error", message?: string): Promise<void>;
}

export interface StartPreviewParams {
  root: string;
  projectName: string;
  api: ApiClient | null;
  projectId: string | null;
  env?: Record<string, string>;
  url?: string;
  port?: number;
  pagePort?: number;
  log?: (l: string) => void;
  timeoutMs?: number;
}

async function qrSvg(text: string): Promise<string | null> {
  try {
    return await QRCode.toString(text, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1d1d1f", light: "#ffffff" } });
  } catch (e) {
    debug("qr failed", e);
    return null;
  }
}

/** Starts (or attaches to) the dev server and serves the preview page; reports status to the API. */
export async function startPreview(p: StartPreviewParams): Promise<PreviewSession> {
  const log = p.log ?? (() => {});
  let dev: DevServer | null = null;
  let framework: string | null = null;
  let label: string | null = null;

  if (!p.url) {
    dev = await startDevServer({ root: p.root, env: forDevServer(p.env ?? {}), port: p.port, timeoutMs: p.timeoutMs });
    framework = dev.plan.framework;
    label = dev.plan.label;
    log(pc.dim(`  starting ${label}: ${dev.plan.file} ${dev.plan.args.join(" ")}`));
  }
  await reportPreview(p.api, p.projectId, { state: "starting", local_url: null, framework });

  let appUrl: string;
  try {
    appUrl = dev ? await dev.ready : await attachDevServer(p.url as string);
  } catch (e) {
    await dev?.stop();
    await reportPreview(p.api, p.projectId, { state: "error", local_url: null, framework, message: describeError(e).message.split("\n")[0]?.slice(0, 500) ?? null });
    throw e;
  }

  const page = await startPreviewPage(
    { project: p.projectName, framework, label: label ?? "Dev server", target_url: appUrl, expo_url: null, qr_svg: null, state: "running", message: null },
    { port: p.pagePort },
  );
  const showExpo = async (url: string | null) => {
    if (!url || page.get().expo_url === url) return;
    page.update({ expo_url: url, qr_svg: await qrSvg(url) });
  };
  if (dev) {
    await showExpo(dev.expoUrl());
    dev.onLine(() => void showExpo(dev?.expoUrl() ?? null));
  }

  await writePreviewFile(p.root, { pid: process.pid, page_url: page.url, app_url: appUrl, framework, started_at: new Date().toISOString() });
  await reportPreview(p.api, p.projectId, { state: "running", local_url: page.url, framework });

  let stopped = false;
  return {
    page,
    dev,
    appUrl,
    framework,
    devExit: dev ? dev.exited : new Promise(() => {}),
    stop: async (reason = "stopped", message) => {
      if (stopped) return;
      stopped = true;
      page.update({ state: reason, message: message ?? null });
      await dev?.stop();
      await removePreviewFile(p.root);
      await reportPreview(p.api, p.projectId, { state: reason, local_url: null, framework, message: message ?? null });
      // Give an open page one poll to show "stopped" before the server goes away.
      await new Promise((r) => setTimeout(r, 300));
      await page.close();
    },
  };
}

export async function previewCommand(ctx: Context, opts: PreviewOptions, log: (l: string) => void = console.log): Promise<void> {
  const project = await findProject();
  const loggedIn = await ctx.session.hasCredentials();
  const root = project?.root ?? process.cwd();
  const port = opts.port ? Number(opts.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new CliError(`--port ${opts.port} isn't a valid port.`);
  const api = project && loggedIn ? ctx.api : null;

  log(`${pc.bold("agnt0 preview")} ${pc.dim(`· ${project?.name ?? root}`)}`);
  if (!api) log(pc.dim(`  ${project ? "Not logged in" : "Not linked to a project"}: the preview runs locally but won't show on your dashboard.`));

  const env = api && project ? await loadDevEnv(api, project.project_id) : {};
  const n = Object.keys(env).length;
  if (n) log(pc.dim(`  env: ${n} dev var${n === 1 ? "" : "s"} injected`));

  const session = await startPreview({
    root,
    projectName: project?.name ?? root.split(/[\\/]/).pop() ?? "Preview",
    api,
    projectId: project?.project_id ?? null,
    env,
    url: opts.url,
    port,
    log,
  });

  log("");
  log(`${pc.green("●")} ${pc.bold("Preview running")}`);
  log(`  ${pc.dim("Preview ")} ${pc.cyan(session.page.url)}`);
  log(`  ${pc.dim("App     ")} ${session.appUrl}${session.framework ? pc.dim(`  (${session.dev?.plan.label})`) : ""}`);
  const expo = session.page.get().expo_url;
  if (expo) log(`  ${pc.dim("Expo    ")} ${expo}  ${pc.dim("(scan the QR code on the preview page with Expo Go)")}`);
  log(pc.dim(`  Mobile 390×844 · Tablet 820×1180 · Desktop 1440 wide · keys 1/2/3, R rotates · Ctrl-C stops`));
  if (opts.browser !== false && (await openBrowser(session.page.url))) log(pc.dim("  Opened in your browser."));

  let printedExpo = Boolean(expo);
  session.dev?.onLine(() => {
    const u = session.page.get().expo_url;
    if (u && !printedExpo) {
      printedExpo = true;
      log(`  ${pc.dim("Expo    ")} ${u}  ${pc.dim("(QR code on the preview page)")}`);
    }
  });

  const outcome = await new Promise<{ kind: "signal" } | { kind: "exit"; code: number | null }>((resolve) => {
    const onSig = () => resolve({ kind: "signal" });
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
    void session.devExit.then((code) => {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      resolve({ kind: "exit", code });
    });
  });

  if (outcome.kind === "signal") {
    log(pc.dim("\nStopping the preview…"));
    await session.stop("stopped");
    log(`${pc.green("✓")} Preview stopped.`);
    return;
  }
  const tail = session.dev?.tail(15).join("\n") ?? "";
  const message = `The dev server exited (code ${outcome.code ?? "?"}).`;
  await session.stop("error", message);
  throw new CliError(`${message}${tail ? `\n${tail}` : ""}`, "Fix the error above, then run agnt0 preview again.");
}
