#!/usr/bin/env node
// Stands in for `claude` in tests: records argv/stdin, then replays a stream-json fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_RECORD) writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));
  if (process.env.FAKE_CLAUDE_MODE === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  const lines = readFileSync(join(here, "claude-stream.jsonl"), "utf8").split("\n");
  for (const l of lines) if (l) process.stdout.write(`${l}\n`);
  if (process.env.FAKE_CLAUDE_MODE === "fail") {
    process.stderr.write("boom\n");
    process.exit(2);
  }
});
