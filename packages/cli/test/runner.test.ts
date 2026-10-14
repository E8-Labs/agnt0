import type { Step, StepEvent } from "@agnt0/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeRunner } from "../src/runners/claude.js";
import { tempDir } from "./helpers.js";

const bin = join(__dirname, "fixtures", "fake-claude.mjs");
let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  process.env.FAKE_CLAUDE_RECORD = join(dir, "record.json");
});
afterEach(async () => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_RECORD;
  await cleanup();
});

const step = { step_id: "s", prompt: "THE PROMPT", model: "haiku", max_turns: 7, allowed_tools: ["read"], scope: [], approval: { requires_approval: [] } } as unknown as Step;

describe("ClaudeRunner (fake claude binary)", () => {
  it("passes the prompt on stdin, streams events and returns usage", async () => {
    const r = new ClaudeRunner(bin);
    expect(await r.isAvailable()).toBe(true);
    const events: StepEvent[] = [];
    const res = await r.run({ step, cwd: dir, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(res.ok).toBe(true);
    expect(res.usage.input_tokens).toBe(1700);
    expect(res.finalText).toContain('"verdict":"approve"');
    expect(events.length).toBe(7);
    const rec = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
    expect(rec.stdin).toBe("THE PROMPT");
    expect(rec.argv).not.toContain("THE PROMPT");
    expect(rec.argv).toEqual(expect.arrayContaining(["-p", "--model", "haiku", "--max-turns", "7", "--allowedTools=Read", "--no-session-persistence"]));
  });

  it("reports a non-zero exit as a failure with stderr", async () => {
    process.env.FAKE_CLAUDE_MODE = "fail";
    const res = await new ClaudeRunner(bin).run({ step, cwd: dir, signal: new AbortController().signal, onEvent: () => {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited with code 2: boom/);
  });

  it("kills the process on abort and reports interrupted", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await new ClaudeRunner(bin).run({ step, cwd: dir, signal: ac.signal, onEvent: () => {} });
    expect(res).toMatchObject({ ok: false, error: "interrupted" });
  });

  it("is unavailable when the binary is missing", async () => {
    expect(await new ClaudeRunner("/nonexistent/claude").isAvailable()).toBe(false);
  });
});
