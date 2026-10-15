import { Command, CommanderError } from "commander";
import { auditCommand } from "./commands/audit.js";
import { checkpointCommand, checkpointsCommand, rollbackCommand } from "./commands/checkpoint.js";
import { doctorCommand } from "./commands/doctor.js";
import { envPullCommand } from "./commands/env.js";
import { previewCommand } from "./commands/preview.js";
import { qaCommand } from "./commands/qa.js";
import { initCommand, linkCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { runCommand } from "./commands/run.js";
import { setupTokenCommand } from "./commands/setup-token.js";
import { statusCommand } from "./commands/status.js";
import { usageCommand } from "./commands/usage.js";
import { watchCommand } from "./commands/watch.js";
import { creditsBuyCommand, creditsUseCommand, openCommand, upgradeCommand } from "./commands/web.js";
import { setApiOverride, setInsecure } from "./config.js";
import { createContext, type Context } from "./context.js";
import { printError } from "./errors.js";
import { CLI_VERSION } from "./version.js";

type Action = (ctx: Context, ...args: any[]) => Promise<unknown>;

/** `-j/--parallel`: a whole number of agents, 1 to 8 (the protocol's cap on a lease request). */
function parallelOption(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new CommanderError(1, "agnt0.parallel", `--parallel must be a whole number from 1 to 8, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function buildProgram(makeContext: () => Context = () => createContext()): Command {
  const program = new Command();

  const wrap =
    (fn: Action) =>
    async (...args: unknown[]) => {
      try {
        await fn(makeContext(), ...args);
      } catch (e) {
        process.exitCode = printError(e);
      }
    };

  program
    .name("agnt0")
    .description("Agent Zero: build apps from your terminal with your own Claude Code or Codex.")
    .version(CLI_VERSION, "-v, --version", "print the agnt0 version")
    .option("--api <url>", "Agent Zero API base URL (default: $AGNT0_API_URL or http://localhost:8787)")
    .option("--insecure", "allow a plain-http API URL that isn't localhost")
    .showHelpAfterError("(run `agnt0 --help` for usage)")
    .hook("preAction", (cmd) => {
      const o = cmd.opts<{ api?: string; insecure?: boolean }>();
      if (o.api) setApiOverride(o.api);
      if (o.insecure) setInsecure(true);
    });

  program
    .command("login")
    .description("sign in from this machine (device code; opens your browser)")
    .option("--no-browser", "print the link instead of opening a browser")
    .action(wrap((ctx, o: { browser: boolean }) => loginCommand(ctx, { browser: o.browser })));

  program.command("logout").description("revoke and delete the tokens stored on this machine").action(wrap((ctx) => logoutCommand(ctx)));

  program
    .command("status")
    .description("account, plan, usage, linked project and runners")
    .option("--json", "machine-readable output")
    .action(wrap((ctx, o: { json?: boolean }) => statusCommand(ctx, o)));

  program
    .command("usage")
    .description("session and weekly meters, reset times, hosted-AI share and extra credits")
    .option("--json", "machine-readable output")
    .action(wrap((ctx, o: { json?: boolean }) => usageCommand(ctx, o)));

  program
    .command("doctor")
    .description("check Node, git, package manager, Claude Code / Codex and ports")
    .option("--json", "print the report as JSON")
    .option("--no-upload", "don't send the report to your account")
    .action(wrap((ctx, o: { json?: boolean; upload: boolean }) => doctorCommand(ctx, o)));

  program
    .command("init [name]")
    .description("set up this folder for Agent Zero: create a project, or attach to one (e.g. made by the web guide)")
    .option("--project <id>", "attach to an existing project instead of creating one")
    .option("--brief <text>", "what you want to build")
    .option("--brief-file <path>", "read the brief from a file")
    .option("--dir <path>", "folder to initialize (default: current folder)")
    .option("--force", "replace an existing link")
    .addHelpText("after", "\nIn an interactive terminal, if your account already has projects, agnt0 asks whether to use one or create a new one.")
    .action(wrap((ctx, name: string | undefined, o) => initCommand(ctx, name, o)));

  program
    .command("link [name]")
    .description("link this existing git repo to a new or existing Agent Zero project")
    .option("--project <id>", "link to an existing project instead of creating one")
    .option("--force", "replace an existing link")
    .addHelpText("after", "\nIn an interactive terminal, if your account already has projects, agnt0 asks whether to use one or create a new one.")
    .action(wrap((ctx, name: string | undefined, o) => linkCommand(ctx, name, o)));

  program
    .command("run")
    .description("start or resume the build loop with your own runner")
    .option("--watch", "keep polling for work when idle or paused")
    .option("--once", "run at most one step, then stop")
    .option("-j, --parallel <n>", "run up to n agents at once (default 1; your plan's limit applies)", parallelOption)
    .action(wrap((ctx, o: { watch?: boolean; once?: boolean; parallel?: number }) => runCommand(ctx, o)));

  program.command("watch").description("full-screen live view of your agents").action(wrap((ctx) => watchCommand(ctx)));

  program
    .command("audit")
    .description("run the Code Auditor on this repo: health score and findings on the dashboard (read-only)")
    .option("--static", "static checks only; don't boot the app")
    .option("--no-run", "only queue it; it runs first on your next `agnt0 run`")
    .option("--skip", "skip the queued or running audit so the Planner can start")
    .action(wrap((ctx, o: { static?: boolean; run: boolean; skip?: boolean }) => auditCommand(ctx, o)));

  program
    .command("preview")
    .description("start the dev server and open the device preview (mobile, tablet, desktop)")
    .option("--no-browser", "don't open a browser")
    .option("--url <url>", "use a dev server that's already running instead of starting one")
    .option("--port <port>", "port for the dev server agnt0 starts")
    .action(wrap((ctx, o: { browser: boolean; url?: string; port?: string }) => previewCommand(ctx, o)));

  program
    .command("qa")
    .description("local QA pass: Chromium at each device size, screenshots and findings to the dashboard")
    .option("--devices <list>", "comma-separated: mobile,tablet,desktop", "mobile,tablet,desktop")
    .option("--pages <list>", "comma-separated paths, e.g. /,/about", "/")
    .option("--url <url>", "test this running app instead of the preview / dev server")
    .option("-y, --yes", "install Chromium without asking if it's missing")
    .action(wrap((ctx, o: { devices?: string; pages?: string; url?: string; yes?: boolean }) => qaCommand(ctx, o)));

  const env = program.command("env").description("project environment variables and secrets");
  env
    .command("pull")
    .description("fetch the project's env vars (count only; values are never printed)")
    .option("-e, --environment <name>", "dev, preview or prod", "dev")
    .option("--write", "write them to a gitignored .env.local (mode 0600)")
    .argument("[command...]", "after --, run this command with the vars injected")
    .addHelpText("after", "\n`agnt0 run` and `agnt0 preview` inject the dev vars on their own.\nExample: agnt0 env pull -- npm test")
    .action(wrap((ctx, command: string[], o: { environment?: string; write?: boolean }) => envPullCommand(ctx, o, command)));

  program
    .command("checkpoint [name]")
    .description("snapshot the working tree (incl. uncommitted files) as a named checkpoint")
    .action(wrap((ctx, name: string | undefined) => checkpointCommand(ctx, name)));

  program
    .command("checkpoints")
    .description("list this project's checkpoints")
    .option("--json", "machine-readable output")
    .action(wrap((ctx, o: { json?: boolean }) => checkpointsCommand(ctx, o)));

  program
    .command("rollback <id>")
    .description("restore a checkpoint on a new safety branch (a pre-rollback checkpoint is taken first)")
    .option("-y, --yes", "don't ask for confirmation")
    .action(wrap((ctx, id: string, o: { yes?: boolean }) => rollbackCommand(ctx, id, o)));

  program
    .command("setup-token")
    .description("mint a long-lived token for CI (build and QA only, scoped to one project)")
    .option("--name <name>", "what to call it, so you can tell two apart")
    .option("--project <id>", "the project it may build (defaults to the one linked here)")
    .option("--list", "list the CI tokens on this account")
    .option("--revoke <nameOrId>", "revoke one")
    .action(wrap((ctx, opts) => setupTokenCommand(ctx, opts)));

  program.command("open").description("open the project dashboard in your browser").action(wrap((ctx) => openCommand(ctx)));

  const credits = program.command("credits").description("extra credits for when a limit is reached");
  credits
    .command("use")
    .description("keep working on extra credits when a limit is reached")
    .option("--off", "turn it off again")
    .action(wrap((ctx, o: { off?: boolean }) => creditsUseCommand(ctx, o)));
  credits.command("buy").description("open the credit packs page").action(wrap((ctx) => creditsBuyCommand(ctx)));

  program.command("upgrade").description("open the plans page").action(wrap((ctx) => upgradeCommand(ctx)));

  // Not a user-facing command: Claude Code re-enters this CLI as the PostToolUse hook for a step
  // that may compress. Hidden because typing it does nothing useful, and it reads its call on stdin.
  program
    .command("__compress-hook", { hidden: true })
    .description("internal: compress one tool result for the step that registered this hook")
    .requiredOption("--dir <dir>", "the step's compression directory")
    .requiredOption("--kinds <kinds>", "comma-separated kinds this step may compress")
    .action(async (opts: { dir: string; kinds: string }) => {
      const { runCompressHook } = await import("./compress/hook.js");
      await runCompressHook(["--dir", opts.dir, "--kinds", opts.kinds]);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      process.exitCode = e.exitCode;
      return;
    }
    process.exitCode = printError(e);
  }
}
