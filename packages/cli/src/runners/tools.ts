/**
 * Translates the server's generic tool grants ("read", "write", "bash:npm test", "git", …) into
 * Claude Code permission rules. Anything that already looks like a Claude rule is passed through.
 */
export function mapAllowedToolsForClaude(allowed: string[], scope: string[]): string[] {
  const out = new Set<string>();
  const scoped = (tool: string) => {
    if (scope.length === 0) out.add(tool);
    else for (const s of scope) out.add(`${tool}(${s})`);
  };
  for (const raw of allowed) {
    const t = raw.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (lower === "read") ["Read", "Glob", "Grep", "LS"].forEach((x) => out.add(x));
    else if (lower === "write" || lower === "edit") {
      scoped("Edit");
      scoped("Write");
    } else if (lower === "git") out.add("Bash(git:*)");
    else if (lower === "bash" || lower === "shell") out.add("Bash");
    else if (lower.startsWith("bash:")) out.add(`Bash(${t.slice(5).trim()}:*)`);
    else if (lower === "web" || lower === "browse") {
      out.add("WebFetch");
      out.add("WebSearch");
    } else if (lower === "todo") out.add("TodoWrite");
    else if (/^[A-Z][A-Za-z]+(\(.*\))?$/.test(t) || t.startsWith("mcp__")) out.add(t);
    else out.add(t);
  }
  return [...out];
}

export const CLAUDE_MODEL_ALIASES = { opus: "opus", sonnet: "sonnet", haiku: "haiku" } as const;
