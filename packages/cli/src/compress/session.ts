/**
 * Wiring the compressor into one step's Claude Code run.
 *
 * Claude Code takes hooks from a settings file, so a step that may compress gets its own settings
 * file naming this CLI as a PostToolUse hook, and `--settings` points at it. The hook writes each
 * original to the same directory and appends what it saved; when the step ends we total that up for
 * the usage report and delete the lot.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agnt0Home } from "../config.js";
import { STATS_FILE, type CompressStat } from "./hook.js";
import { tokensFromBytes, type CompressKind } from "./index.js";

export interface CompressSession {
  /** Passed to Claude Code as `--settings`. Empty when this step does not compress. */
  settingsPath: string | null;
  /** Raw and sent tool-output tokens, for the step's usage report. */
  totals: () => Promise<{ raw_tool_tokens: number; sent_tool_tokens: number }>;
  cleanup: () => Promise<void>;
}

export const NO_COMPRESSION: CompressSession = {
  settingsPath: null,
  totals: async () => ({ raw_tool_tokens: 0, sent_tool_tokens: 0 }),
  cleanup: async () => {},
};

function stepDir(stepId: string): string {
  return join(agnt0Home(), "compress", stepId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64));
}

/**
 * The script Claude Code runs as the hook: this same CLI, re-entered on its own entry point, so there
 * is no second binary to ship and no copy of the compressor to keep in step.
 *
 * Finding that entry has to be exact, because a wrong guess would run something else entirely. In an
 * installed CLI `process.argv[1]` is the bin script; from a bundled build this module's own file is
 * that bundle. A `.ts` entry (running from source under tsx) is not something plain node can run, so
 * compression is skipped rather than half-wired — `AGNT0_HOOK_ENTRY` is the way to point it at a
 * built entry during development.
 */
export function hookEntry(): string | null {
  const candidates = [process.env.AGNT0_HOOK_ENTRY, process.argv[1], fileURLToPath(import.meta.url)];
  for (const c of candidates) {
    if (c && /\.(?:js|mjs|cjs)$/.test(c)) return c;
  }
  return null;
}

function hookCommand(entry: string, dir: string, kinds: CompressKind[]): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return [quote(process.execPath), quote(entry), "__compress-hook", "--dir", quote(dir), "--kinds", quote(kinds.join(","))].join(" ");
}

export async function startCompressSession(stepId: string, kinds: CompressKind[]): Promise<CompressSession> {
  const entry = hookEntry();
  if (!kinds.length || !entry) return NO_COMPRESSION;
  const dir = stepDir(stepId);
  await mkdir(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: "Bash|BashOutput", hooks: [{ type: "command", command: hookCommand(entry, dir, kinds) }] }],
    },
  };
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  return {
    settingsPath,
    totals: async () => {
      let raw = 0;
      let sent = 0;
      try {
        const text = await readFile(join(dir, STATS_FILE), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const s = JSON.parse(line) as CompressStat;
          raw += s.raw;
          sent += s.sent;
        }
      } catch {
        // No stats file means no tool output passed through the hook; zero is the honest number.
      }
      return { raw_tool_tokens: tokensFromBytes(raw), sent_tool_tokens: tokensFromBytes(sent) };
    },
    // The originals exist so the agent can read them *during* the step; afterwards they are nobody's.
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
