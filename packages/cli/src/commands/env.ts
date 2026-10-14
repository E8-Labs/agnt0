import { EnvName } from "@agnt0/protocol";
import { execa } from "execa";
import pc from "picocolors";
import { relative } from "node:path";
import { type Context, requireLogin } from "../context.js";
import { forDevServer, pullEnv, splitForRunner, writeEnvLocal, type EnvVars } from "../env.js";
import { CliError } from "../errors.js";
import { requireProject } from "../project.js";

export interface EnvPullOptions {
  environment?: string;
  write?: boolean;
}

/**
 * `agnt0 env pull`: fetches the project's env vars and prints how many there are (keys only, never
 * values). `--write` writes them to a gitignored `.env.local` (mode 0600). With `-- <command>` it runs
 * that command with the vars injected. `run` and `preview` inject the dev vars on their own.
 */
export async function envPullCommand(
  ctx: Context,
  opts: EnvPullOptions,
  command: string[] = [],
  log: (l: string) => void = console.log,
): Promise<{ vars: EnvVars; written?: string; exitCode?: number }> {
  await requireLogin(ctx);
  const project = await requireProject();
  const env = EnvName.safeParse(opts.environment ?? "dev");
  if (!env.success) throw new CliError(`Unknown environment "${opts.environment}".`, "Use dev, preview or prod.");
  if (opts.write && command.length) throw new CliError("Use either --write or a command to run, not both.");

  const vars = (await pullEnv(ctx.api, project.project_id, env.data)) ?? {};
  const keys = Object.keys(vars).sort();
  if (!keys.length) {
    log(`No ${env.data} env vars set for ${pc.bold(project.name ?? project.project_id)}. Add them on the dashboard: ${ctx.webUrl}/p/${project.project_id}/env`);
    if (!command.length) return { vars };
  } else {
    log(`${pc.green("✓")} ${keys.length} ${env.data} env var${keys.length === 1 ? "" : "s"}: ${pc.dim(keys.join(", "))}`);
  }

  if (opts.write) {
    if (!keys.length) return { vars };
    const res = await writeEnvLocal(project.root, vars);
    log(`  Wrote ${relative(process.cwd(), res.path) || res.path} ${pc.dim("(mode 0600)")}${res.gitignoreUpdated ? pc.dim(" and added it to .gitignore") : pc.dim(", already gitignored")}`);
    return { vars, written: res.path };
  }

  if (command.length) {
    const [file, ...args] = command as [string, ...string[]];
    const r = await execa(file, args, { cwd: process.cwd(), env: forDevServer(vars), stdio: "inherit", reject: false });
    process.exitCode = r.exitCode ?? 1;
    return { vars, exitCode: r.exitCode ?? 1 };
  }

  const { heldBack } = splitForRunner(vars);
  log(pc.dim(`  Kept in memory only. ${pc.reset("agnt0 run")} and ${pc.reset("agnt0 preview")} inject the dev vars into what they start.`));
  if (heldBack.length) log(pc.dim(`  Never passed to Claude Code / Codex: ${heldBack.join(", ")} (they'd change your runner's own login).`));
  log(pc.dim(`  Write a gitignored .env.local instead: agnt0 env pull --write · run a command with them: agnt0 env pull -- npm test`));
  return { vars };
}
