import { Command, CommanderError } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand, linkCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { usageCommand } from "./commands/usage.js";
import { watchCommand } from "./commands/watch.js";
import { creditsBuyCommand, creditsUseCommand, openCommand, upgradeCommand } from "./commands/web.js";
import { setApiOverride } from "./config.js";
import { createContext, type Context } from "./context.js";
import { printError } from "./errors.js";
import { CLI_VERSION } from "./version.js";

type Action = (ctx: Context, ...args: any[]) => Promise<unknown>;

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
    .showHelpAfterError("(run `agnt0 --help` for usage)")
    .hook("preAction", (cmd) => {
      const api = cmd.opts<{ api?: string }>().api;
      if (api) setApiOverride(api);
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
    .action(wrap((ctx, o: { watch?: boolean; once?: boolean }) => runCommand(ctx, o)));

  program.command("watch").description("full-screen live view of your agents").action(wrap((ctx) => watchCommand(ctx)));

  program.command("open").description("open the project dashboard in your browser").action(wrap((ctx) => openCommand(ctx)));

  const credits = program.command("credits").description("extra credits for when a limit is reached");
  credits
    .command("use")
    .description("keep working on extra credits when a limit is reached")
    .option("--off", "turn it off again")
    .action(wrap((ctx, o: { off?: boolean }) => creditsUseCommand(ctx, o)));
  credits.command("buy").description("open the credit packs page").action(wrap((ctx) => creditsBuyCommand(ctx)));

  program.command("upgrade").description("open the plans page").action(wrap((ctx) => upgradeCommand(ctx)));

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
