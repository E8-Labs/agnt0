# agnt0 — Agent Zero CLI (public repo)

Agent Zero is a thin-client build system: this free CLI drives the user's own Claude Code or Codex,
while the paid Agent Zero cloud (private repo `agnt0-cloud`) owns prompts, the orchestrator, decision
points, skills, billing and usage limits. **Nothing proprietary ever lives in this repo**: no role
prompts, no routing rules, no pricing math. The CLI receives one step at a time and keeps it in memory.

## Layout
- `packages/protocol` — `@agnt0/protocol`, zod schemas for every request/response + the route table.
  It is the contract. Change it only deliberately; bump `PROTOCOL_VERSION` on breaking changes.
- `packages/cli` — the `agnt0` binary (Node 20+, TypeScript, commander, Ink for TUI screens).

## Conventions
- TypeScript strict, ESM, Node 20+. pnpm workspaces. No default exports except Ink components.
- Wire format is snake_case and always validated with the protocol schemas on both ends.
- Paths inside a user's repo live under `.agnt0/` (worktrees at `.agnt0/wt/<ticket>`), excluded via
  `.git/info/exclude`, never committed.
- Tokens: OS keychain via `@napi-rs/keyring`, fallback `~/.agnt0/credentials.json` mode 0600.
- Config: `AGNT0_API_URL` (default `http://localhost:8787`), `AGNT0_WEB_URL` (default `http://localhost:3000`),
  `AGNT0_TOKEN` for CI.
- Tests: vitest. Every command has at least a smoke test with the API mocked.
- Output style: `packages/cli/STYLE.md` — the symbols, tables, meters and error shape every command
  shares. Read it before adding a command or changing what one prints.
- License: Elastic License 2.0 (placeholder pending legal review). Third-party notices in `THIRD_PARTY_NOTICES`.
