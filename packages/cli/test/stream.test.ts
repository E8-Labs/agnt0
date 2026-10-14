import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@agnt0/protocol";
import { describe, expect, it } from "vitest";
import { claudeArgs } from "../src/runners/claude.js";
import { ClaudeStreamParser } from "../src/runners/claude-stream.js";
import { CodexStreamParser } from "../src/runners/codex.js";
import { extractJsonOutput } from "../src/runners/json-output.js";
import { mapAllowedToolsForClaude } from "../src/runners/tools.js";

const fixture = readFileSync(join(__dirname, "fixtures", "claude-stream.jsonl"), "utf8").split("\n");

function parseAll(lines: string[]) {
  const p = new ClaudeStreamParser("sonnet", () => "2026-10-13T12:00:00.000Z");
  const events = lines.flatMap((l) => p.push(l));
  return { p, events };
}

describe("Claude stream-json parsing", () => {
  it("sums usage and keeps the model reported by Claude Code", () => {
    const { p } = parseAll(fixture);
    expect(p.usage()).toEqual({
      runner: "claude",
      model: "claude-sonnet-4-5",
      input_tokens: 1700,
      output_tokens: 250,
      cache_read_tokens: 18000,
      cache_write_tokens: 900,
      raw_tool_tokens: 0,
      sent_tool_tokens: 0,
    });
    expect(p.sawResult).toBe(true);
    expect(p.isError).toBe(false);
    expect(p.numTurns).toBe(3);
  });

  it("falls back to per-turn usage (deduped by message id) when there is no result line", () => {
    const { p } = parseAll(fixture.filter((l) => !l.includes('"type":"result"')));
    const u = p.usage();
    expect(u.input_tokens).toBe(1700); // msg_1 counted once even though streamed twice
    expect(u.cache_read_tokens).toBe(18000);
    expect(p.sawResult).toBe(false);
  });

  it("never reports less than the per-turn sum when the result under-counts", () => {
    const lines = fixture.map((l) => (l.includes('"type":"result"') ? l.replace('"input_tokens":1700', '"input_tokens":10') : l));
    expect(parseAll(lines).p.usage().input_tokens).toBe(1700);
  });

  it("extracts tool calls, file edits, browsing, messages and tool errors as step events", () => {
    const { events } = parseAll(fixture);
    expect(events.map((e) => e.type)).toEqual(["message", "tool_call", "file_diff", "tool_call", "log", "browse", "message"]);
    expect(events[1]).toMatchObject({ type: "tool_call", summary: "Read src/app.ts", data: { tool: "Read" } });
    expect(events[2]).toMatchObject({ type: "file_diff", summary: "Edit src/app.ts", data: { file: "src/app.ts" } });
    expect(events[3]).toMatchObject({ summary: "Bash npm test" });
    expect(events[4]!.summary).toContain("1 test failed");
    expect(events[5]).toMatchObject({ type: "browse", summary: "WebFetch https://example.com/docs" });
    expect(events.every((e) => e.at === "2026-10-13T12:00:00.000Z" && e.summary.length <= 2000)).toBe(true);
  });

  it("pulls the JSON output out of the final result", () => {
    const { p } = parseAll(fixture);
    expect(extractJsonOutput(p.finalText())).toEqual({ verdict: "approve", findings: [], acceptance: [{ criterion: "x is 2", met: true }] });
  });

  it("flags max-turn and error results", () => {
    const { p } = parseAll(['{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":5,"usage":{"input_tokens":5,"output_tokens":1}}']);
    expect(p.isError).toBe(true);
    expect(p.subtype).toBe("error_max_turns");
  });
});

describe("permission denials", () => {
  // Exactly what claude 2.1.299 emitted when it refused `rm -f` inside the working directory.
  const toolUse = JSON.stringify({
    type: "assistant",
    message: { id: "m1", model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -f /tmp/permtest/a.txt" } }] },
  });
  const denied = JSON.stringify({
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    message: "rm in '/tmp/permtest/a.txt' needs approval. The path is inside the working directories for this session ('/tmp/permtest'), and Claude Code asks before a shell command creates, changes or removes files there.",
  });

  it("reports Claude Code's own reason, tagged with the approval category", () => {
    const { p, events } = parseAll([toolUse, denied]);
    const log = events.find((e) => e.data?.permission_denied === true)!;
    expect(log).toBeDefined();
    expect(log.data?.approval_needed).toBe("delete");
    expect(log.data?.reason).toContain("needs approval");
    expect(log.data?.reason).toContain("working directories");
    // The category stays in the summary so the step summary can still group by it.
    expect(log.summary).toContain("needs approval: delete");
    expect(log.summary).toContain("asks before a shell command");
    expect(p.approvalsNeeded).toContain("delete");
  });

  it("reports each denied call once, however many times Claude mentions it", () => {
    const { events } = parseAll([toolUse, denied, denied]);
    expect(events.filter((e) => e.data?.permission_denied === true)).toHaveLength(1);
  });

  it("still names the tool when the denial arrives without a matching tool_use", () => {
    const { events } = parseAll([denied]);
    const log = events.find((e) => e.data?.permission_denied === true)!;
    expect(log.data?.tool).toBe("Bash");
    expect(log.summary).toContain("needs approval");
  });
});

describe("JSON output extraction", () => {
  it("prefers the last ```json block", () => {
    const text = 'first\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```\n';
    expect(extractJsonOutput(text)).toEqual({ a: 2 });
  });
  it("skips broken json fences and falls back to other fences", () => {
    const text = '```json\n{not json}\n```\n```\n{"b":true}\n```';
    expect(extractJsonOutput(text)).toEqual({ b: true });
  });
  it("finds a bare trailing object, even with braces inside strings", () => {
    const text = 'Summary: done {see notes}.\n{"tickets":[{"key":"T1","title":"Use {braces} ok"}]}';
    expect(extractJsonOutput(text)).toEqual({ tickets: [{ key: "T1", title: "Use {braces} ok" }] });
  });
  it("returns undefined when nothing parses", () => {
    expect(extractJsonOutput("no json here")).toBeUndefined();
  });
});

describe("Claude invocation", () => {
  const step = {
    model: "opus",
    max_turns: 25,
    allowed_tools: ["read", "write", "bash:npm test", "git"],
    scope: ["src/**"],
    approval: { requires_approval: ["delete", "install", "push"] },
  } as unknown as Step;

  it("builds headless args without the prompt (it goes on stdin)", () => {
    const args = claudeArgs(step);
    expect(args.slice(0, 9)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--max-turns", "25", "--model", "opus"]);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("--allowedTools=Bash(npm test)");
    expect(args).toContain("--allowedTools=Edit(src/**)");
    // Every value is glued to its flag, so nothing can be read as an option.
    for (const a of args.slice(9)) if (a.startsWith("--allowedTools") || a.startsWith("--disallowedTools")) expect(a).toContain("=");
    expect(args).not.toContain("--allowedTools=Bash");
  });

  it("turns approval categories into deny rules and never grants an unrestricted shell", () => {
    const args = claudeArgs(step);
    expect(args).toContain("--disallowedTools=Bash(rm:*)");
    expect(args).toContain("--disallowedTools=Bash(npm install:*)");
    expect(args).toContain("--disallowedTools=Bash(git push:*)");
    const bare = claudeArgs({ ...step, allowed_tools: ["bash"] } as unknown as Step);
    expect(bare.some((a) => a === "--allowedTools=Bash")).toBe(false);
  });

  it("drops acceptEdits when writes need approval", () => {
    const args = claudeArgs({ ...step, approval: { requires_approval: ["write"] } } as unknown as Step);
    expect(args).not.toContain("acceptEdits");
  });

  it("refuses tool grants that look like flags", () => {
    expect(() => claudeArgs({ ...step, allowed_tools: ["--dangerously-skip-permissions"] } as unknown as Step)).toThrow();
  });

  it("maps generic tool grants to Claude permission rules", () => {
    const rules = mapAllowedToolsForClaude(["read", "write", "git", "WebFetch"], []);
    expect(rules).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "LS", "Edit", "Write", "WebFetch", "Bash(git status:*)", "Bash(git diff:*)"]));
    // "git" means safe read/commit commands only — never push or arbitrary git.
    expect(rules).not.toContain("Bash(git:*)");
    expect(rules.some((r) => r.startsWith("Bash(git push"))).toBe(false);
  });
});

describe("Codex JSON parsing (experimental)", () => {
  it("sums turn usage and extracts events", () => {
    const p = new CodexStreamParser();
    const lines = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.started","item":{"id":"1","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"2","type":"file_change","changes":[{"path":"a.ts","kind":"update"}]}}',
      '{"type":"item.completed","item":{"id":"3","type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}',
    ];
    const events = lines.flatMap((l) => p.push(l, "t"));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "file_diff", "message"]);
    expect(p.usage()).toMatchObject({ runner: "codex", input_tokens: 100, cache_read_tokens: 40, output_tokens: 10 });
    expect(p.lastMessage).toBe("done");
  });
});
