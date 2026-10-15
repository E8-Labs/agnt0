import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Step, StepSkill } from "@agnt0/protocol";
import { claudeArgs } from "../src/runners/claude.js";
import { loadStepSkills, parseBundle, skillCacheDir } from "../src/runners/skills.js";
import { makeRepo, tempDir } from "./helpers.js";

let dir: string;
let home: string;
let cleanup: () => Promise<void>;
let homeCleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir("agnt0-skills-repo-"));
  ({ dir: home, cleanup: homeCleanup } = await tempDir("agnt0-skills-home-"));
  process.env.AGNT0_HOME = home;
  await makeRepo(dir);
});
afterEach(async () => {
  delete process.env.AGNT0_HOME;
  await cleanup();
  await homeCleanup();
});

function step(over: Partial<Step> = {}): Step {
  return {
    step_id: "stp_skills1",
    project_id: "prj_1",
    ticket_id: "tkt_1",
    kind: "build",
    role: "frontend_developer",
    runner: "claude",
    model: "sonnet",
    prompt: "do the ticket",
    output_schema: null,
    compression: { read: [], write: "full" },
    allowed_tools: ["read", "skill"],
    scope: ["**/*"],
    worktree: ".agnt0/wt/tkt_1",
    branch: "agnt0/tkt_1",
    base_branch: null,
    skills: [],
    approval: { requires_approval: [] },
    checkpoint_before: false,
    lease_expires_at: "2026-10-15T13:00:00Z",
    max_turns: 30,
    ...over,
  };
}

const SKILL_MD = "---\nname: okapi-rule\ndescription: Use when the okapi constant is asked for.\n---\n\nThe okapi constant is 5512.\n";

function bundle(files: { path: string; content: string; executable?: boolean }[] = [{ path: "SKILL.md", content: Buffer.from(SKILL_MD).toString("base64") }], slug = "okapi-rule") {
  const body = gzipSync(Buffer.from(JSON.stringify({ format: "agnt0-skill-bundle/1", slug, version: "1", files })));
  return { body, sha256: createHash("sha256").update(body).digest("hex") };
}

const inlineSkill: StepSkill = { id: "skl_1", slug: "okapi-rule", version: "1", inline: SKILL_MD, cache: false };

describe("step skills", () => {
  it("writes an inline skill as a plugin Claude Code can load, and deletes it with the step", async () => {
    const loaded = await loadStepSkills(step({ skills: [inlineSkill] }), { cwd: dir, repoRoot: dir });
    expect(loaded.problems).toEqual([]);
    expect(loaded.loaded).toEqual([{ slug: "okapi-rule", version: "1", cached: false }]);
    const root = loaded.pluginDirs[0]!;
    const manifest = JSON.parse(await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    // One plugin for the whole step, named from the manifest rather than from whatever directory it
    // sits in, so a skill addresses as `agnt0:<slug>` instead of repeating itself.
    expect(manifest.name).toBe("agnt0");
    expect(await readFile(join(root, "skills", "okapi-rule", "SKILL.md"), "utf8")).toBe(SKILL_MD);
    // Nothing inside the user's repo.
    expect(root.startsWith(home)).toBe(true);

    await loaded.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("passes one --plugin-dir per skill, and nothing when the step has none", () => {
    expect(claudeArgs(step(), [])).not.toContain("--plugin-dir");
    const args = claudeArgs(step(), ["/tmp/a", "/tmp/b"]);
    expect(args).toContain("--plugin-dir=/tmp/a");
    expect(args).toContain("--plugin-dir=/tmp/b");
    // The skill grant reaches Claude as its own tool name, or the model could never read the skill.
    expect(args).toContain("--allowedTools=Skill");
  });

  it("verifies the checksum, caches what it may reuse, and skips a skill it cannot trust", async () => {
    const b = bundle();
    let fetches = 0;
    const fetchBundle = async () => {
      fetches++;
      return b.body;
    };
    const cacheable: StepSkill = { id: "skl_2", slug: "okapi-rule", version: "1", sha256: b.sha256, url: "https://api.example/skill", cache: true };

    const first = await loadStepSkills(step({ skills: [cacheable] }), { cwd: dir, repoRoot: dir, fetchBundle });
    expect(first.problems).toEqual([]);
    expect(first.loaded[0]!.cached).toBe(true);
    expect(fetches).toBe(1);
    // Cleanup leaves the cached copy alone: its data files are public and expensive to fetch again.
    await first.cleanup();
    expect(existsSync(join(skillCacheDir("okapi-rule", "1"), "SKILL.md"))).toBe(true);
    expect(existsSync(first.pluginDirs[0]!)).toBe(false);

    const second = await loadStepSkills(step({ step_id: "stp_skills2", skills: [cacheable] }), { cwd: dir, repoRoot: dir, fetchBundle });
    expect(second.problems).toEqual([]);
    expect(fetches).toBe(1); // reused, not downloaded again

    // Whatever the fetch returns is checked against the step's own checksum, so no transport — real
    // or stubbed — can get an unverified bundle onto disk.
    const tampered = await loadStepSkills(
      step({ step_id: "stp_skills3", skills: [{ ...cacheable, version: "2", sha256: "0".repeat(64) }] }),
      { cwd: dir, repoRoot: dir, fetchBundle: async () => b.body },
    );
    expect(tampered.loaded).toEqual([]);
    expect(tampered.pluginDirs).toEqual([]);
    expect(tampered.problems[0]).toContain("checksum did not match");
  });

  it("refuses a bundle that is not what it claims to be", () => {
    const escape = bundle([
      { path: "SKILL.md", content: Buffer.from(SKILL_MD).toString("base64") },
      { path: "../../evil.sh", content: Buffer.from("x").toString("base64") },
    ]);
    expect(() => parseBundle(escape.body, { slug: "okapi-rule" })).toThrow(/will write/);
    const noMain = bundle([{ path: "notes.md", content: "eA==" }]);
    expect(() => parseBundle(noMain.body, { slug: "okapi-rule" })).toThrow(/SKILL\.md/);
    const wrongSkill = bundle(undefined, "something-else");
    expect(() => parseBundle(wrongSkill.body, { slug: "okapi-rule" })).toThrow(/is for something-else/);
    const notABundle = gzipSync(Buffer.from(JSON.stringify({ format: "tar", files: [] })));
    expect(() => parseBundle(notABundle, { slug: "okapi-rule" })).toThrow(/unknown bundle format/);
  });

  it("gives Codex its skills in the worktree, excluded from git and gone afterwards", async () => {
    const loaded = await loadStepSkills(step({ runner: "codex", skills: [inlineSkill] }), { cwd: dir, repoRoot: dir });
    expect(loaded.problems).toEqual([]);
    // Codex reads `.agents/skills/<name>`; it is the only place it looks that is not the user's own
    // global settings.
    const target = join(dir, ".agents", "skills", "okapi-rule", "SKILL.md");
    expect(await readFile(target, "utf8")).toBe(SKILL_MD);
    expect(loaded.pluginDirs).toEqual([]);
    expect(await readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".agents/");

    await loaded.cleanup();
    expect(existsSync(join(dir, ".agents", "skills", "okapi-rule"))).toBe(false);
  });

  it("does nothing at all when the step carries no skills", async () => {
    const loaded = await loadStepSkills(step({ skills: [] }), { cwd: dir, repoRoot: dir });
    expect(loaded.pluginDirs).toEqual([]);
    expect(existsSync(join(home, "skills"))).toBe(false);
  });
});
