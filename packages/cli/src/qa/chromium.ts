import { execa } from "execa";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { CliError } from "../errors.js";
import { confirm, type Ask } from "../prompt.js";

type PlaywrightCore = typeof import("playwright-core");

export async function loadPlaywright(): Promise<PlaywrightCore> {
  try {
    return await import("playwright-core");
  } catch {
    throw new CliError("agnt0 qa needs playwright-core, which isn't installed with this copy of agnt0.", "Reinstall: npm i -g agnt0@latest");
  }
}

/** Path Playwright expects Chromium at (honours PLAYWRIGHT_BROWSERS_PATH), and whether it's there. */
export async function chromiumStatus(): Promise<{ path: string; installed: boolean }> {
  const pw = await loadPlaywright();
  let path = "";
  try {
    path = pw.chromium.executablePath();
  } catch {
    /* unknown platform */
  }
  return { path, installed: Boolean(path) && existsSync(path) };
}

/** The installer that matches this playwright-core version exactly (so the browser revision lines up). */
function installerCommand(): { file: string; args: string[] } {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("playwright-core/package.json");
  return { file: process.execPath, args: [join(dirname(pkg), "cli.js"), "install", "chromium"] };
}

/**
 * Makes sure Chromium is available for QA. Already installed → nothing happens. Otherwise asks first
 * (or proceeds with --yes) and runs Playwright's own installer, which is the same as
 * `npx playwright install chromium` pinned to the bundled version.
 */
export async function ensureChromium(opts: { yes?: boolean; ask: Ask | null; log: (l: string) => void }): Promise<string> {
  const status = await chromiumStatus();
  if (status.installed) return status.path;
  const cmd = installerCommand();
  if (!opts.yes) {
    if (!opts.ask) {
      throw new CliError("agnt0 qa needs Chromium (about 150 MB, installed once).", "Run it in a terminal to confirm, or pass --yes to install it now.");
    }
    opts.log(`agnt0 qa drives a headless Chromium to test your app. It isn't installed yet ${pc.dim("(about 150 MB, one time)")}.`);
    if (!(await confirm(opts.ask, "Install Chromium now?", true))) throw new CliError("QA needs Chromium.", "Install it later with: npx playwright install chromium");
  }
  opts.log(pc.dim(`  Installing Chromium (npx playwright install chromium)…`));
  const r = await execa(cmd.file, cmd.args, { stdio: "inherit", reject: false });
  if (r.exitCode !== 0) throw new CliError("Chromium didn't install.", "Try it yourself: npx playwright install chromium");
  const after = await chromiumStatus();
  if (!after.installed) throw new CliError("Chromium still isn't where Playwright expects it.", "Try: npx playwright install chromium");
  return after.path;
}
