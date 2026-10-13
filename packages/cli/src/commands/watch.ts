import { createElement } from "react";
import { type Context, requireLogin } from "../context.js";
import { CliError } from "../errors.js";
import { requireProject } from "../project.js";

export async function watchCommand(ctx: Context): Promise<void> {
  await requireLogin(ctx);
  const project = await requireProject();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("`agnt0 watch` needs an interactive terminal.", "Use the dashboard instead: agnt0 open");
  }
  const [{ render }, { default: WatchApp }, { createWatchSource }] = await Promise.all([
    import("ink"),
    import("../watch/App.js"),
    import("../watch/source.js"),
  ]);
  const source = createWatchSource({ api: ctx.api, apiUrl: ctx.apiUrl, projectId: project.project_id, tokens: ctx.session });
  // Alternate screen buffer for a clean full-screen view.
  process.stdout.write("\u001b[?1049h");
  try {
    const app = render(createElement(WatchApp, { projectLabel: project.name ?? project.project_id, source }), { exitOnCtrlC: true });
    await app.waitUntilExit();
  } finally {
    process.stdout.write("\u001b[?1049l");
  }
}
