/**
 * Step tool policy → Claude Code permission rules.
 *
 * The server grants generic tools ("read", "write", "bash:npm test", "bash:pnpm *") and lists risky
 * categories that need approval ("delete", "install", "migrate", "push", "network", sometimes "write").
 * Rules here are deliberately conservative:
 *  - a bare "bash"/"shell" grant is never turned into unrestricted `Bash`;
 *  - every value is validated against a strict pattern before it reaches argv;
 *  - every approval category becomes `--disallowedTools` rules, which beat allow rules in Claude Code.
 */
import { CliError } from "../errors.js";

export const CLAUDE_MODEL_ALIASES = { opus: "opus", sonnet: "sonnet", haiku: "haiku" } as const;

/** Command patterns: words, paths, globs and simple flags. No shell metacharacters, no leading dash. */
const BASH_PATTERN = /^[A-Za-z0-9_.@/][A-Za-z0-9_.@/:=+,* -]{0,199}$/;
const GENERIC_TOOL = /^[a-z][a-z_]{0,30}$/;
const CLAUDE_TOOL_NAME = /^[A-Z][A-Za-z]{1,40}$/;
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]{1,100}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9_.@/*{},-][A-Za-z0-9_.@/*{}, -]{0,199}$/;

/** Shell tools Claude Code exposes; never granted wholesale. */
const UNRESTRICTED_SHELLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

/** Read-only git subcommands granted by a generic "git" tool (push/reset/clean are never implied). */
const SAFE_GIT = ["git status", "git diff", "git log", "git show", "git add", "git commit", "git branch --list", "git rev-parse"];

export const APPROVAL_RULES: Record<string, string[]> = {
  write: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  delete: [
    "Bash(rm:*)",
    "Bash(rmdir:*)",
    "Bash(unlink:*)",
    "Bash(shred:*)",
    "Bash(git rm:*)",
    "Bash(git clean:*)",
    "Bash(git reset --hard:*)",
    "Bash(git branch -D:*)",
    "Bash(git branch -d:*)",
    "Bash(git push --delete:*)",
  ],
  install: [
    "Bash(npm install:*)",
    "Bash(npm i:*)",
    "Bash(npm ci:*)",
    "Bash(npm add:*)",
    "Bash(npm uninstall:*)",
    "Bash(npm update:*)",
    "Bash(pnpm install:*)",
    "Bash(pnpm i:*)",
    "Bash(pnpm add:*)",
    "Bash(pnpm remove:*)",
    "Bash(pnpm update:*)",
    "Bash(pnpm dlx:*)",
    "Bash(yarn install:*)",
    "Bash(yarn add:*)",
    "Bash(yarn remove:*)",
    "Bash(yarn dlx:*)",
    "Bash(bun install:*)",
    "Bash(bun add:*)",
    "Bash(bunx:*)",
    "Bash(npx:*)",
    "Bash(pip install:*)",
    "Bash(pip3 install:*)",
    "Bash(brew install:*)",
    "Bash(apt install:*)",
    "Bash(apt-get install:*)",
  ],
  migrate: [
    "Bash(npx prisma migrate:*)",
    "Bash(npx prisma db push:*)",
    "Bash(pnpm prisma migrate:*)",
    "Bash(pnpm prisma db push:*)",
    "Bash(pnpm exec prisma migrate:*)",
    "Bash(pnpm exec prisma db push:*)",
    "Bash(npx drizzle-kit migrate:*)",
    "Bash(npx drizzle-kit push:*)",
    "Bash(pnpm drizzle-kit migrate:*)",
    "Bash(pnpm drizzle-kit push:*)",
    "Bash(pnpm exec drizzle-kit:*)",
    "Bash(pnpm db:*)",
    "Bash(pnpm run db:*)",
    "Bash(pnpm migrate:*)",
    "Bash(pnpm run migrate:*)",
    "Bash(npm run db:*)",
    "Bash(npm run migrate:*)",
    "Bash(npx knex migrate:*)",
    "Bash(npx sequelize db:migrate:*)",
    "Bash(supabase db push:*)",
    "Bash(rails db:migrate:*)",
    "Bash(python manage.py migrate:*)",
    "Bash(alembic upgrade:*)",
    "Bash(psql:*)",
  ],
  push: [
    "Bash(git push:*)",
    "Bash(gh pr create:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh release:*)",
    "Bash(npm publish:*)",
    "Bash(pnpm publish:*)",
    "Bash(yarn publish:*)",
    "Bash(vercel:*)",
    "Bash(pnpm vercel:*)",
  ],
  network: [
    "WebFetch",
    "WebSearch",
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(ssh:*)",
    "Bash(scp:*)",
    "Bash(rsync:*)",
    "Bash(nc:*)",
    "Bash(git fetch:*)",
    "Bash(git pull:*)",
    "Bash(git clone:*)",
  ],
};

export interface ClaudePermissions {
  allowed: string[];
  disallowed: string[];
  /** `acceptEdits` unless writes need approval; null = Claude Code's default mode. */
  permissionMode: "acceptEdits" | null;
  /** Grants that were dropped (e.g. bare `bash`), for the user-facing log. */
  dropped: string[];
}

function invalid(value: string): CliError {
  return new CliError(`The step asked for a tool this CLI won't pass on: ${JSON.stringify(value.slice(0, 80))}.`, "Report this to Agent Zero support; nothing was run.");
}

/** `bash:git diff *` → `Bash(git diff:*)`; `bash:npm test` → `Bash(npm test)`; mid-string globs pass through. */
function bashRule(cmd: string): string {
  const c = cmd.trim().replace(/\s+/g, " ");
  if (c.endsWith(" *") && !c.slice(0, -2).includes("*")) return `Bash(${c.slice(0, -2)}:*)`;
  if (c.endsWith(":*")) return `Bash(${c})`;
  return `Bash(${c})`;
}

function validateScope(scope: string[]): string[] {
  for (const s of scope) if (!SCOPE_PATTERN.test(s) || s.includes("..")) throw invalid(s);
  return scope;
}

export function mapClaudePermissions(allowed: string[], scope: string[], requiresApproval: string[]): ClaudePermissions {
  const needs = new Set(requiresApproval.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const scoped = validateScope(scope);
  const out = new Set<string>();
  const dropped: string[] = [];
  const addScoped = (tool: string) => {
    if (scoped.length === 0) out.add(tool);
    else for (const s of scoped) out.add(`${tool}(${s})`);
  };

  for (const raw of allowed) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("-")) throw invalid(t);
    const lower = t.toLowerCase();

    if (lower.startsWith("bash:")) {
      const cmd = t.slice(5).trim();
      if (!cmd || cmd === "*" || !BASH_PATTERN.test(cmd)) throw invalid(t);
      out.add(bashRule(cmd));
      continue;
    }
    if (GENERIC_TOOL.test(t)) {
      switch (t) {
        case "read":
          ["Read", "Glob", "Grep", "LS"].forEach((x) => out.add(x));
          break;
        case "glob":
          out.add("Glob");
          break;
        case "grep":
          out.add("Grep");
          break;
        case "ls":
          out.add("LS");
          break;
        case "write":
        case "edit":
          if (needs.has("write")) dropped.push(t);
          else {
            addScoped("Edit");
            addScoped("Write");
            addScoped("MultiEdit");
          }
          break;
        case "git":
          SAFE_GIT.forEach((g) => out.add(`Bash(${g}:*)`));
          break;
        case "web":
        case "browse":
          out.add("WebFetch");
          out.add("WebSearch");
          break;
        case "todo":
          out.add("TodoWrite");
          break;
        case "skill":
          // Loading one of the step's skills. Granted only when the step carries skills; without it a
          // `--allowedTools` run can see a skill's description and never be allowed to read it.
          out.add("Skill");
          break;
        case "bash":
        case "shell":
          // Never an unrestricted shell: the server must name commands (bash:<pattern>).
          dropped.push(t);
          break;
        default:
          dropped.push(t);
      }
      continue;
    }
    if (CLAUDE_TOOL_NAME.test(t)) {
      if (UNRESTRICTED_SHELLS.has(t)) dropped.push(t);
      else if (needs.has("write") && APPROVAL_RULES.write!.includes(t)) dropped.push(t);
      else out.add(t);
      continue;
    }
    if (MCP_TOOL_NAME.test(t)) {
      out.add(t);
      continue;
    }
    throw invalid(t);
  }

  const disallowed = new Set<string>();
  for (const cat of needs) for (const r of APPROVAL_RULES[cat] ?? []) disallowed.add(r);

  return {
    allowed: [...out].filter((r) => !disallowed.has(r)),
    disallowed: [...disallowed],
    permissionMode: needs.has("write") ? null : "acceptEdits",
    dropped,
  };
}

/** Back-compat helper used by tests and docs: allowed rules only, no approval categories. */
export function mapAllowedToolsForClaude(allowed: string[], scope: string[]): string[] {
  return mapClaudePermissions(allowed, scope, []).allowed;
}

/** Which approval category (if any) a denied Claude tool call falls into. */
export function categorizeDenial(toolName: string, input: unknown): string | null {
  const command = typeof (input as { command?: unknown })?.command === "string" ? ((input as { command: string }).command.trim().replace(/\s+/g, " ")) : null;
  for (const [cat, rules] of Object.entries(APPROVAL_RULES)) {
    for (const rule of rules) {
      const m = /^Bash\((.*)\)$/.exec(rule);
      if (!m) {
        if (rule === toolName) return cat;
        continue;
      }
      if (toolName !== "Bash" || !command) continue;
      const pattern = m[1]!;
      const prefix = pattern.endsWith(":*") ? pattern.slice(0, -2) : null;
      if (prefix !== null ? command === prefix || command.startsWith(`${prefix} `) : command === pattern) return cat;
    }
  }
  return null;
}
