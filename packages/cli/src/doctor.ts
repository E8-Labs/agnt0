import type { DoctorReport } from "@agnt0/protocol";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeOs } from "./auth/device.js";
import { commandVersion } from "./runners/spawn.js";
import { CLI_VERSION } from "./version.js";

export type CheckId = DoctorReport["checks"][number]["id"];
export interface Check {
  id: CheckId;
  ok: boolean;
  detail: string;
  version?: string;
}

export interface DoctorResult {
  report: DoctorReport;
  fixes: Partial<Record<CheckId, string>>;
  /** Everything needed to run the build loop is in place. */
  ready: boolean;
  /** Checks that don't block `agnt0 run`. */
  optional: Set<CheckId>;
  /** Things worth saying even when everything needed is in place. */
  notes?: string[];
}

export const CHECK_LABELS: Record<CheckId, string> = {
  node: "Node.js",
  git: "git",
  package_manager: "Package manager",
  claude: "Claude Code",
  claude_login: "Claude Code login",
  codex: "Codex",
  codex_login: "Codex login",
  ports: "Ports 3000, 5173",
};

const FIXES: Record<CheckId, string> = {
  node: "Install Node.js 20 or newer: https://nodejs.org (or `nvm install 22`)",
  git: "Install git: https://git-scm.com/downloads",
  package_manager: "npm ships with Node.js; for pnpm run `corepack enable pnpm`",
  claude: "Install Claude Code: npm i -g @anthropic-ai/claude-code",
  claude_login: "Run `claude` once and sign in (or `claude auth login`)",
  codex: "Optional: npm i -g @openai/codex",
  codex_login: "Run `codex login`",
  ports: "Stop the dev server using that port, or let Agent Zero pick another one",
};

export function nodeCheck(version = process.versions.node): Check {
  const major = Number(version.split(".")[0]);
  return { id: "node", ok: major >= 20, detail: major >= 20 ? `v${version}` : `v${version} is too old (need 20+)`, version };
}

async function gitCheck(): Promise<Check> {
  const v = await commandVersion("git");
  const version = v?.match(/(\d+\.\d+(\.\d+)?)/)?.[1];
  return v ? { id: "git", ok: true, detail: v, ...(version ? { version } : {}) } : { id: "git", ok: false, detail: "git not found" };
}

async function packageManagerCheck(): Promise<Check> {
  const names = ["pnpm", "npm", "yarn", "bun"];
  const versions = await Promise.all(names.map((n) => commandVersion(n)));
  const found = names.map((n, i) => (versions[i] ? `${n} ${versions[i]}` : null)).filter(Boolean) as string[];
  if (!found.length) return { id: "package_manager", ok: false, detail: "no npm, pnpm, yarn or bun found" };
  const firstIdx = versions.findIndex(Boolean);
  const version = versions[firstIdx]?.match(/(\d+\.\d+(\.\d+)?)/)?.[1];
  return { id: "package_manager", ok: true, detail: found.join(", "), ...(version ? { version } : {}) };
}

async function claudeChecks(): Promise<Check[]> {
  const bin = process.env.AGNT0_CLAUDE_BIN ?? "claude";
  const v = await commandVersion(bin);
  if (!v) {
    return [
      { id: "claude", ok: false, detail: "claude not found" },
      { id: "claude_login", ok: false, detail: "Claude Code isn't installed" },
    ];
  }
  const version = v.match(/(\d+\.\d+\.\d+)/)?.[1];
  const install: Check = { id: "claude", ok: true, detail: v, ...(version ? { version } : {}) };
  // `claude auth status` (recent versions) answers without spending tokens; `claude -p` would cost a turn.
  try {
    const r = await execa(bin, ["auth", "status"], { reject: false, timeout: 15000 });
    if (r.exitCode === 0 && r.stdout.trim().startsWith("{")) {
      const s = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
      if (typeof s.loggedIn === "boolean") {
        return [install, { id: "claude_login", ok: s.loggedIn, detail: s.loggedIn ? `logged in${s.authMethod ? ` (${s.authMethod})` : ""}` : "not logged in" }];
      }
    }
  } catch {
    /* fall through to heuristics */
  }
  const credFile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
  if (existsSync(credFile)) return [install, { id: "claude_login", ok: true, detail: "credentials found (not verified)" }];
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return [install, { id: "claude_login", ok: true, detail: "API key / token in environment (not verified)" }];
  }
  return [install, { id: "claude_login", ok: false, detail: "couldn't confirm a Claude Code login" }];
}

async function codexChecks(): Promise<Check[]> {
  const bin = process.env.AGNT0_CODEX_BIN ?? "codex";
  const v = await commandVersion(bin);
  if (!v) {
    return [
      { id: "codex", ok: false, detail: "codex not found (optional)" },
      { id: "codex_login", ok: false, detail: "Codex isn't installed (optional)" },
    ];
  }
  const version = v.match(/(\d+\.\d+\.\d+)/)?.[1];
  const install: Check = { id: "codex", ok: true, detail: v, ...(version ? { version } : {}) };
  try {
    const r = await execa(bin, ["login", "status"], { reject: false, timeout: 15000 });
    if (r.exitCode === 0) return [install, { id: "codex_login", ok: true, detail: (r.stdout || r.stderr).trim().split("\n")[0] || "logged in" }];
  } catch {
    /* heuristics below */
  }
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  if (existsSync(auth)) return [install, { id: "codex_login", ok: true, detail: "credentials found (not verified)" }];
  if (process.env.OPENAI_API_KEY) return [install, { id: "codex_login", ok: true, detail: "OPENAI_API_KEY set (not verified)" }];
  return [install, { id: "codex_login", ok: false, detail: "not logged in" }];
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

async function portsCheck(ports = [3000, 5173]): Promise<Check> {
  const free = await Promise.all(ports.map(isPortFree));
  const busy = ports.filter((_, i) => !free[i]);
  return busy.length ? { id: "ports", ok: false, detail: `in use: ${busy.join(", ")}` } : { id: "ports", ok: true, detail: "free" };
}

export function summarize(checks: Check[]): DoctorResult {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const okId = (id: CheckId) => byId.get(id)?.ok === true;
  const claudeReady = okId("claude") && okId("claude_login");
  const codexReady = okId("codex") && okId("codex_login");
  const optional = new Set<CheckId>(["ports"]);
  if (claudeReady) ["codex", "codex_login"].forEach((i) => optional.add(i as CheckId));
  if (codexReady && !claudeReady) ["claude", "claude_login"].forEach((i) => optional.add(i as CheckId));
  if (!okId("codex")) optional.add("codex_login");
  const ready = okId("node") && okId("git") && okId("package_manager") && (claudeReady || codexReady);
  const fixes: DoctorResult["fixes"] = {};
  for (const c of checks) if (!c.ok) fixes[c.id] = FIXES[c.id];
  const notes: string[] = [];
  // Codex confines a step with its sandbox and refuses anything that asks to escalate out of it,
  // because `codex exec` has nobody to ask. Worth saying, since it means a risky command is denied
  // outright rather than put to the user.
  if (codexReady && !claudeReady) {
    notes.push("Codex steps are confined by Codex's own sandbox. A command that needs more than that is refused rather than queued for your approval, because a headless Codex run can't prompt.");
  }
  return { report: { cli_version: CLI_VERSION, os: describeOs(), checks }, fixes, ready, optional, ...(notes.length ? { notes } : {}) };
}

export async function runDoctorChecks(): Promise<DoctorResult> {
  const [git, pm, claude, codex, ports] = await Promise.all([gitCheck(), packageManagerCheck(), claudeChecks(), codexChecks(), portsCheck()]);
  return summarize([nodeCheck(), git, pm, ...claude, ...codex, ports]);
}
