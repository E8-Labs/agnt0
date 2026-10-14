import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexArgs, codexSandbox } from "../src/runners/codex.js";
import { chooseModel, parseCatalog, selectable } from "../src/runners/codex-models.js";
import { buildCodexPolicy, tokenize, tokensFromClaudeRule } from "../src/runners/codex-policy.js";
import { tempDir } from "./helpers.js";

const BUILD = { kind: "build" } as const;

/** The grants a build step actually gets from the server, trimmed to what matters here. */
const ALLOWED = ["read", "write", "edit", "bash:npm test", "bash:node --test *", "bash:git status", "bash:git diff *", "bash:git add *", "bash:ls *"];
const APPROVALS = ["delete", "install", "migrate", "push", "network"];

describe("codex args", () => {
  it("never persists the session, pins the working root and names the model", () => {
    const args = codexArgs(BUILD, { cwd: "/repo/.agnt0/wt/tkt_1", model: { model: "gpt-6-sol", reasoningEffort: "high" } });
    // Role prompts are server-only text; a saved session would put them on disk.
    expect(args).toContain("--ephemeral");
    // The worktree sits inside the repo, so the writable root has to be stated.
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe("/repo/.agnt0/wt/tkt_1");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-sol");
    expect(args).toContain('model_reasoning_effort="high"');
    // Prompt still arrives on stdin, never in argv where `ps` would show it.
    expect(args[args.length - 1]).toBe("-");
  });

  it("says nothing about the model when the catalog could not be read", () => {
    const args = codexArgs(BUILD, { model: { model: null, reasoningEffort: null } });
    expect(args).not.toContain("--model");
    expect(args.some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  });

  it("only lets steps that write have a writable sandbox", () => {
    expect(codexSandbox({ kind: "plan" })).toBe("read-only");
    expect(codexSandbox({ kind: "review" })).toBe("read-only");
    expect(codexSandbox({ kind: "audit" })).toBe("read-only");
    expect(codexSandbox({ kind: "build" })).toBe("workspace-write");
    expect(codexSandbox({ kind: "fix" })).toBe("workspace-write");
  });
});

describe("codex execpolicy", () => {
  it("turns a bash grant into tokens and refuses anything shell-ish", () => {
    expect(tokenize("npm run *")).toEqual(["npm", "run"]);
    expect(tokenize("git status")).toEqual(["git", "status"]);
    for (const bad of ["rm -rf / && echo", "ls; rm", "$(whoami)", "a|b", "`id`", ""]) {
      expect(tokenize(bad), bad).toBeNull();
    }
  });

  it("reads tokens out of the shared Claude approval rules", () => {
    expect(tokensFromClaudeRule("Bash(git push:*)")).toEqual(["git", "push"]);
    expect(tokensFromClaudeRule("Bash(rm:*)")).toEqual(["rm"]);
    // Not a shell command: the sandbox governs network, not the execpolicy.
    expect(tokensFromClaudeRule("WebFetch")).toBeNull();
  });

  it("allows the grants, prompts for the approval categories and drops non-shell tools", () => {
    const { rules, dropped } = buildCodexPolicy(ALLOWED, APPROVALS);
    expect(rules).toContain('prefix_rule(pattern=["git", "status"])');
    expect(rules).toContain('prefix_rule(pattern=["node", "--test"])');
    expect(rules).toContain('prefix_rule(pattern=["git", "push"], decision="prompt")');
    expect(rules).toContain('prefix_rule(pattern=["rm"], decision="prompt")');
    // Codex's own tools have no shell form.
    expect(dropped).toEqual(expect.arrayContaining(["read", "write", "edit"]));
    // No shell metacharacter reaches a rule (comments are prose and may contain punctuation).
    const ruleLines = rules.split("\n").filter((l) => l.startsWith("prefix_rule"));
    expect(ruleLines.length).toBeGreaterThan(5);
    for (const line of ruleLines) expect(line, line).not.toMatch(/[;&|`$]/);
  });

  it("emits no approval rules when the project approves nothing", () => {
    expect(buildCodexPolicy(ALLOWED, []).rules).not.toContain("prompt");
  });
});

/**
 * Codex ships its own policy evaluator, so the generated rules are checked against it rather than
 * against our belief about them. Skipped where Codex is not installed.
 */
const codexAvailable = await execa("codex", ["--version"], { reject: false })
  .then((r) => r.exitCode === 0)
  .catch(() => false);

describe.skipIf(!codexAvailable)("codex execpolicy, evaluated by codex itself", () => {
  const decide = async (rulesPath: string, command: string[]): Promise<string> => {
    const r = await execa("codex", ["execpolicy", "check", "-r", rulesPath, ...command], { reject: false });
    const out = JSON.parse(r.stdout) as { decision?: string };
    return out.decision ?? "none";
  };

  it("decides each command the way the step intended", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const path = join(dir, "step.rules");
      await writeFile(path, buildCodexPolicy(ALLOWED, APPROVALS).rules);

      // Granted commands run.
      expect(await decide(path, ["git", "status", "--short"])).toBe("allow");
      expect(await decide(path, ["node", "--test", "tests/"])).toBe("allow");
      expect(await decide(path, ["npm", "test"])).toBe("allow");
      // Risky ones ask, even though a broader grant covers their first word.
      expect(await decide(path, ["git", "push", "origin", "main"])).toBe("prompt");
      expect(await decide(path, ["rm", "-rf", "src"])).toBe("prompt");
      expect(await decide(path, ["npm", "install", "left-pad"])).toBe("prompt");
      // `network` covers curl, so reaching the network asks rather than silently going ahead.
      expect(await decide(path, ["curl", "http://example.com"])).toBe("prompt");
      // Never granted and in no category: no rule matches, so Codex's own approval policy decides.
      expect(await decide(path, ["chmod", "777", "src"])).toBe("none");
    } finally {
      await cleanup();
    }
  });

  it("lets the narrower rule win whichever order the rules are written in", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const a = join(dir, "a.rules");
      const b = join(dir, "b.rules");
      await writeFile(a, 'prefix_rule(pattern=["git"])\nprefix_rule(pattern=["git","push"], decision="prompt")\n');
      await writeFile(b, 'prefix_rule(pattern=["git","push"], decision="prompt")\nprefix_rule(pattern=["git"])\n');
      for (const p of [a, b]) {
        expect(await decide(p, ["git", "status"])).toBe("allow");
        expect(await decide(p, ["git", "push"])).toBe("prompt");
      }
    } finally {
      await cleanup();
    }
  });
});

describe("codex model tiers", () => {
  // Shaped like a real `codex debug models` payload, including entries a user cannot pick.
  const catalog = JSON.stringify({
    models: [
      { slug: "top", visibility: "list", supported_in_api: true, priority: 1, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
      { slug: "mid", visibility: "list", supported_in_api: true, priority: 5, supported_reasoning_levels: [{ effort: "medium" }] },
      { slug: "cheap", visibility: "list", supported_in_api: true, priority: 13, supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "internal", visibility: "hide", supported_in_api: true, priority: 2 },
      { slug: "no-api", visibility: "list", supported_in_api: false, priority: 3 },
    ],
  });

  it("ignores models a user cannot choose and ranks the rest", () => {
    expect(selectable(parseCatalog(catalog)).map((m) => m.slug)).toEqual(["top", "mid", "cheap"]);
  });

  it("maps each tier by rank, not by name", () => {
    const models = parseCatalog(catalog);
    expect(chooseModel("opus", models)).toEqual({ model: "top", reasoningEffort: "high" });
    expect(chooseModel("sonnet", models)).toEqual({ model: "mid", reasoningEffort: "medium" });
    expect(chooseModel("haiku", models)).toEqual({ model: "cheap", reasoningEffort: "low" });
  });

  it("names no model at all rather than guessing when the catalog is empty or broken", () => {
    expect(chooseModel("opus", [])).toEqual({ model: null, reasoningEffort: null });
    expect(chooseModel("opus", parseCatalog('{"models":[]}'))).toEqual({ model: null, reasoningEffort: null });
    expect(parseCatalog('{"nope":1}')).toEqual([]);
  });
});
