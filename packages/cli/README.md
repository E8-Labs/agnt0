# agnt0

The Agent Zero command-line client. It signs you in, asks the Agent Zero cloud for the next
build step, runs that step on your machine with **your own Claude Code** (or Codex, experimental),
and streams the results back to your dashboard.

The CLI is free to install. Building needs an Agent Zero plan. The orchestration, prompts and
skills live on Agent Zero's servers, never in this package.

## Requirements

- Node.js 20 or newer
- git
- [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code), installed and signed in
  (or the Codex CLI, experimental)

## Install

From npm:

```sh
npm i -g agnt0
```

From the source repo:

```sh
git clone <repo-url> agnt0 && cd agnt0
pnpm install
pnpm --filter agnt0 build
npm i -g ./packages/cli        # or: cd packages/cli && npm link
```

As a tarball (no workspace needed on the target machine):

```sh
cd packages/cli && npm pack     # → agnt0-<version>.tgz
npm i -g ./agnt0-<version>.tgz
```

## Quick start

```sh
agnt0 login        # opens your browser; confirm the code shown in the terminal
agnt0 doctor       # checks Node, git, Claude Code login, ports
agnt0 init my-app --brief "A habit tracker with streaks"
agnt0 run          # works through steps until there's nothing ready
agnt0 watch        # in another terminal: live view of your agents
```

## Commands

| Command | What it does | Needs a plan |
| --- | --- | --- |
| `agnt0 login [--no-browser]` | Device-code sign-in; stores tokens in the OS keychain (or `~/.agnt0/credentials.json`, mode 0600) | No |
| `agnt0 logout` | Revokes and deletes the tokens on this machine | No |
| `agnt0 status [--json]` | Account, plan, session/week meters, linked project, API connection, runners | No |
| `agnt0 usage [--json]` | Session and weekly meters with reset times, hosted-AI share, extra-credit wallet | No |
| `agnt0 doctor [--json] [--no-upload]` | Checks Node ≥ 20, git, package manager, Claude Code / Codex install and login, ports 3000/5173 | No |
| `agnt0 init [name] [--brief <text> \| --brief-file <path>] [--dir <path>]` | Creates a project, `git init` if needed, writes `.agnt0/project.json` | Yes |
| `agnt0 link [name]` | Links the current git repo to a new project (sends the HEAD sha) | Yes |
| `agnt0 run [--watch] [--once]` | The build loop: lease a step, run it in `.agnt0/wt/<ticket>`, report back, repeat | Yes |
| `agnt0 watch` | Full-screen view: agent tiles, approvals waiting, live events, usage strip (`q` quits) | Yes |
| `agnt0 open` | Opens the project dashboard | Yes |
| `agnt0 credits use [--off]` | Keep working on extra credits when a limit is reached | No |
| `agnt0 credits buy` / `agnt0 upgrade` | Open the credit packs / plans page | No |

Global options: `--api <url>`, `--version`, `--help`.

## How `agnt0 run` works

1. Sends a heartbeat every 30 seconds and asks `POST /v1/projects/{id}/steps/next` for work.
2. For a step: takes a checkpoint (`refs/agnt0/checkpoints/<step>`) when asked, creates or reuses
   the ticket's git worktree under `.agnt0/wt/`, and runs
   `claude -p --output-format stream-json --verbose --max-turns … --model … --permission-mode acceptEdits --allowedTools …`
   with the step prompt on stdin.
3. Tool calls, edits and messages stream to the dashboard every 2 seconds. Token usage is read from
   Claude Code's own output.
4. The work is committed on the ticket branch (`agnt0: <ticket> <role>`) and the outcome, diff stats
   and usage are reported.
5. When idle it prints why and exits (`--watch` keeps polling). When a usage limit is reached it
   pauses, prints the reset time and how to keep going (`agnt0 credits use`, `agnt0 upgrade`), and
   exits 0. Ctrl-C reports the current step as interrupted.

Step prompts are kept in memory only; they are never written to disk or logs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGNT0_API_URL` | `http://localhost:8787` | Agent Zero API (same as `--api`) |
| `AGNT0_WEB_URL` | `http://localhost:3000` | Dashboard used by `open`, `upgrade`, `credits buy` |
| `AGNT0_TOKEN` | – | Token for CI; overrides stored login |
| `AGNT0_HOME` | `~/.agnt0` | Where the credentials fallback and cache live |
| `AGNT0_NO_KEYRING=1` | – | Skip the OS keychain and use the credentials file |
| `AGNT0_NO_BROWSER=1` | – | Never open a browser |
| `AGNT0_CLAUDE_BIN` / `AGNT0_CODEX_BIN` | `claude` / `codex` | Runner binaries |
| `DEBUG=agnt0` | – | Verbose logs and stack traces |

## License

Elastic License 2.0. See `LICENSE` and `THIRD_PARTY_NOTICES`.
