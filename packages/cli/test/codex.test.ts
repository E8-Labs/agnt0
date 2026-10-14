import { describe, expect, it } from "vitest";
import { codexArgs, codexSandbox } from "../src/runners/codex.js";
import { chooseModel, parseCatalog, selectable } from "../src/runners/codex-models.js";

const BUILD = { kind: "build" } as const;

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

  /**
   * The sandbox is the whole enforcement story for Codex. `codex exec` pins its approval policy to
   * Never — there is no one to ask in a headless run — so a command that asks to escalate out of the
   * sandbox is rejected rather than queued for approval. That makes the sandbox mode per step kind
   * the only thing standing between a step and the rest of the machine.
   */
  it("only lets steps that write have a writable sandbox", () => {
    expect(codexSandbox({ kind: "plan" })).toBe("read-only");
    expect(codexSandbox({ kind: "review" })).toBe("read-only");
    expect(codexSandbox({ kind: "audit" })).toBe("read-only");
    expect(codexSandbox({ kind: "build" })).toBe("workspace-write");
    expect(codexSandbox({ kind: "fix" })).toBe("workspace-write");
  });

  it("never asks for an unsandboxed or approval-bypassing run", () => {
    for (const kind of ["plan", "build", "review", "fix", "audit"] as const) {
      const args = codexArgs({ kind }, { cwd: "/repo" });
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--dangerously-bypass-hook-trust");
      expect(args).not.toContain("--approve-for-me");
      expect(args).not.toContain("--full-auto");
      expect(args[args.indexOf("--sandbox") + 1]).not.toBe("danger-full-access");
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
