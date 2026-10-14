import { execa } from "execa";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpoint, finalizeWorktree, WorktreeManager } from "../src/worktree.js";
import { makeRepo, tempDir } from "./helpers.js";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => cleanup());

const git = async (cwd: string, ...args: string[]) => (await execa("git", args, { cwd })).stdout.trim();

describe("worktree manager", () => {
  it("creates .agnt0/wt/<ticket> on the step branch and reuses it", async () => {
    await makeRepo(dir);
    const mgr = new WorktreeManager(dir);
    const wt = await mgr.ensure(".agnt0/wt/tkt_41", "agnt0/tkt_41");
    expect(wt.created).toBe(true);
    expect(wt.path).toBe(join(dir, ".agnt0", "wt", "tkt_41"));
    expect(existsSync(join(wt.path, ".git"))).toBe(true);
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agnt0/tkt_41");
    expect(wt.baseSha).toBe(await git(dir, "rev-parse", "HEAD"));

    const again = await mgr.ensure(".agnt0/wt/tkt_41", "agnt0/tkt_41");
    expect(again.created).toBe(false);
    expect(again.path).toBe(wt.path);

    // .agnt0/ is excluded so the main checkout stays clean
    expect(await readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".agnt0/");
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  it("checks out an existing branch instead of recreating it", async () => {
    await makeRepo(dir);
    await git(dir, "branch", "agnt0/tkt_7");
    const wt = await new WorktreeManager(dir).ensure(".agnt0/wt/tkt_7", "agnt0/tkt_7");
    expect(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agnt0/tkt_7");
  });

  it("makes an initial commit in a brand-new repo so it can branch", async () => {
    await makeRepo(dir, false);
    const wt = await new WorktreeManager(dir).ensure(".agnt0/wt/tkt_1", null);
    expect(wt.branch).toBe("agnt0/tkt_1");
    expect(await git(dir, "log", "--format=%s")).toBe("agnt0: initial commit");
  });

  // A ticket that depends on another has to start from that ticket's branch, not an empty trunk.
  it("cuts a new branch from the base the server names", async () => {
    await makeRepo(dir);
    const trunk = await git(dir, "rev-parse", "HEAD");
    const mgr = new WorktreeManager(dir);

    // Finish tkt_1 with a commit of its own.
    const first = await mgr.ensure(".agnt0/wt/tkt_1", "agnt0/tkt_1");
    await writeFile(join(first.path, "a.txt"), "from tkt_1\n");
    await finalizeWorktree(first.path, first.baseSha, "agnt0: tkt_1");
    const tip = await git(dir, "rev-parse", "agnt0/tkt_1");
    expect(tip).not.toBe(trunk);

    // tkt_2 depends on it, so it starts at tkt_1's tip and can already see the file.
    const second = await mgr.ensure(".agnt0/wt/tkt_2", "agnt0/tkt_2", "agnt0/tkt_1");
    expect(second.baseSha).toBe(tip);
    expect(await readFile(join(second.path, "a.txt"), "utf8")).toBe("from tkt_1\n");

    // With no base it still starts from the trunk.
    const third = await mgr.ensure(".agnt0/wt/tkt_3", "agnt0/tkt_3");
    expect(third.baseSha).toBe(trunk);
    expect(existsSync(join(third.path, "a.txt"))).toBe(false);
  });

  it("falls back to HEAD when the base is unknown locally or not a clean ref", async () => {
    await makeRepo(dir);
    const trunk = await git(dir, "rev-parse", "HEAD");
    const mgr = new WorktreeManager(dir);

    // A branch this clone has never heard of: branching from the trunk is emptier but always safe.
    const missing = await mgr.ensure(".agnt0/wt/tkt_4", "agnt0/tkt_4", "agnt0/never_existed");
    expect(missing.baseSha).toBe(trunk);

    // Anything that would not survive sanitising is not used as a ref either.
    for (const [i, bad] of ["--upload-pack=touch /tmp/pwned", "agnt0/tkt_1;rm -rf /", "../../etc"].entries()) {
      const wt = await mgr.ensure(`.agnt0/wt/tkt_bad${i}`, `agnt0/tkt_bad${i}`, bad);
      expect(wt.baseSha).toBe(trunk);
    }
  });

  it("leaves an existing branch where it is, whatever base is passed", async () => {
    await makeRepo(dir);
    const mgr = new WorktreeManager(dir);
    const first = await mgr.ensure(".agnt0/wt/tkt_1", "agnt0/tkt_1");
    await writeFile(join(first.path, "a.txt"), "x\n");
    await finalizeWorktree(first.path, first.baseSha, "agnt0: tkt_1");

    // tkt_5's branch already exists at the trunk; a later fix step must not move it onto tkt_1.
    await git(dir, "branch", "agnt0/tkt_5");
    const at = await git(dir, "rev-parse", "agnt0/tkt_5");
    const wt = await mgr.ensure(".agnt0/wt/tkt_5", "agnt0/tkt_5", "agnt0/tkt_1");
    expect(wt.baseSha).toBe(at);
    expect(await git(dir, "rev-parse", "agnt0/tkt_5")).toBe(at);
  });

  it("refuses worktree paths outside .agnt0/wt", async () => {
    await makeRepo(dir);
    const mgr = new WorktreeManager(dir);
    await expect(mgr.ensure("../escape", "x")).rejects.toThrow(/Refusing/);
    await expect(mgr.ensure(".agnt0/wt/../../src", "x")).rejects.toThrow(/Refusing/);
    await expect(mgr.ensure("/etc", "x")).rejects.toThrow(/Refusing/);
    await expect(mgr.ensure(".agnt0/wt", "x")).rejects.toThrow(/Refusing/);
  });

  it("measures and commits the work so the branch carries it", async () => {
    await makeRepo(dir);
    const wt = await new WorktreeManager(dir).ensure(".agnt0/wt/tkt_2", "agnt0/tkt_2");
    await writeFile(join(wt.path, "a.txt"), "one\ntwo\n");
    await writeFile(join(wt.path, "b.txt"), "three\n");
    const diff = await finalizeWorktree(wt.path, wt.baseSha, "agnt0: tkt_2 frontend_developer");
    expect(diff).toMatchObject({ files_changed: 2, lines_added: 3, lines_removed: 0 });
    expect(diff.head_sha).toBe(await git(dir, "rev-parse", "agnt0/tkt_2"));
    expect(await git(wt.path, "log", "-1", "--format=%s")).toBe("agnt0: tkt_2 frontend_developer");
  });

  it("creates checkpoint refs", async () => {
    await makeRepo(dir);
    const ref = await createCheckpoint(dir, "stp_1");
    expect(ref).toBe("refs/agnt0/checkpoints/stp_1");
    expect(await git(dir, "rev-parse", ref!)).toBe(await git(dir, "rev-parse", "HEAD"));
  });
});
