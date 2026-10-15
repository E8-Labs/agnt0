/**
 * `agnt0 setup-token` — mints a long-lived token for CI, and `--list` / `--revoke` to manage them.
 *
 * The secret is printed once and never again. That is worth being loud about: a person who misses it
 * has to mint another, and a person who pastes it into a log has leaked a year of access to their
 * project. So the output says what it can do, what it cannot, and where to put it.
 */
import { CiTokenCreated, CiTokenList, m2routes } from "@agnt0/protocol";
import pc from "picocolors";
import { requireLogin, type Context } from "../context.js";
import { CliError } from "../errors.js";
import { findProject } from "../project.js";
import { relTime, sym, table } from "../ui.js";

export interface SetupTokenOptions {
  name?: string;
  project?: string;
  list?: boolean;
  revoke?: string;
}

export async function setupTokenCommand(ctx: Context, opts: SetupTokenOptions): Promise<void> {
  await requireLogin(ctx);

  if (opts.list) {
    const { tokens } = await ctx.api.get(m2routes.ciTokens, { schema: CiTokenList });
    if (!tokens.length) {
      console.log("No CI tokens. Make one with `agnt0 setup-token`.");
      return;
    }
    console.log(
      table([
        [pc.dim("TOKEN"), pc.dim("PROJECT"), pc.dim("LAST USED"), pc.dim("EXPIRES")],
        ...tokens.map((t) => [t.name, t.project_id, t.last_used_at ? relTime(t.last_used_at) : pc.dim("never"), relTime(t.expires_at)]),
      ]),
    );
    console.log(pc.dim(`\nRevoke one with \`agnt0 setup-token --revoke <name or id>\`.`));
    return;
  }

  if (opts.revoke) {
    const { tokens } = await ctx.api.get(m2routes.ciTokens, { schema: CiTokenList });
    const match = tokens.filter((t) => t.id === opts.revoke || t.name === opts.revoke);
    if (!match.length) throw new CliError(`No CI token called ${JSON.stringify(opts.revoke)}.`, "List them with `agnt0 setup-token --list`.");
    if (match.length > 1) {
      throw new CliError(`${match.length} tokens are called ${JSON.stringify(opts.revoke)}.`, `Revoke by id instead: ${match.map((t) => t.id).join(", ")}.`);
    }
    await ctx.api.delete(m2routes.ciToken(match[0]!.id));
    console.log(`${sym.ok} Revoked ${match[0]!.name}. Any pipeline using it stops working now.`);
    return;
  }

  const projectId = opts.project ?? (await findProject(process.cwd()))?.project_id;
  if (!projectId) {
    throw new CliError(
      "A CI token belongs to one project, and this folder is not linked to one.",
      "Run it inside a linked repo, or name the project: `agnt0 setup-token --project prj_…`.",
    );
  }

  const created = await ctx.api.post(m2routes.setupToken, {
    body: { project_id: projectId, ...(opts.name ? { name: opts.name } : {}) },
    schema: CiTokenCreated,
  });

  console.log(`${sym.ok} CI token ${pc.bold(created.token.name)} for ${created.token.project_id}, good until ${relTime(created.token.expires_at).replace("in ", "")} from now.\n`);
  console.log(pc.bold("  " + created.secret) + "\n");
  console.log(pc.yellow("  This is the only time it is shown.") + " Put it in your CI secrets as AGNT0_TOKEN.\n");
  console.log(table([
    [pc.dim("It can"), "run the build loop and QA on this project"],
    [pc.dim("It cannot"), "touch billing, credits, your secrets, or any other project"],
    [pc.dim("Revoke it"), "agnt0 setup-token --revoke " + created.token.name],
  ]));
  console.log(pc.dim("\nIn a pipeline:"));
  console.log(pc.dim("  env: { AGNT0_TOKEN: ${{ secrets.AGNT0_TOKEN }} }"));
  console.log(pc.dim("  run: npx agnt0 run --once"));
}
