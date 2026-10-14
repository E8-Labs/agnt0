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
agnt0 login        # opens your browser; confirm the code (use --no-browser to just print the link)
agnt0 doctor       # checks Node, git, Claude Code login, ports
agnt0 init my-app --brief "A habit tracker with streaks"   # or: agnt0 init --project <id from the web guide>
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
| `agnt0 init [name] [--project <id>] [--brief <text> \| --brief-file <path>] [--dir <path>]` | Creates a project, or attaches to an existing one with `--project`; `git init` if needed, writes `.agnt0/project.json` | Yes |
| `agnt0 link [name] [--project <id>]` | Links the current git repo to a new project (sends the HEAD sha), or to an existing one with `--project` | Yes |
| `agnt0 run [--watch] [--once]` | The build loop: lease a step, run it in `.agnt0/wt/<ticket>`, report back, repeat | Yes |
| `agnt0 watch` | Full-screen view: agent tiles, approvals waiting, live events, usage strip (`q` quits) | Yes |
| `agnt0 audit [--static] [--no-run] [--skip]` | Queues the Code Auditor (read-only), prints the credit estimate and runs that one step now; `--static` skips booting the app, `--skip` lets the Planner start without it | Yes |
| `agnt0 preview [--no-browser] [--url <url>] [--port <n>]` | Starts the dev server (Next.js, Vite, Expo or an npm `dev` script) and opens the built-in device preview | Free |
| `agnt0 qa [--devices mobile,tablet,desktop] [--pages /,/about] [--url <url>] [--yes]` | Local QA pass with headless Chromium: screenshots and findings to the dashboard | Yes |
| `agnt0 env pull [-e dev\|preview\|prod] [--write] [-- <command>]` | Fetches the project's env vars (prints the count, never values); `--write` writes a gitignored `.env.local` | Yes |
| `agnt0 checkpoint [name]` / `agnt0 checkpoints` | Snapshots the working tree as a named checkpoint / lists them | Free |
| `agnt0 rollback <id> [--yes]` | Restores a checkpoint on a new safety branch after a pre-rollback checkpoint | Free |
| `agnt0 open` | Opens the project dashboard | Yes |
| `agnt0 credits use [--off]` | Keep working on extra credits when a limit is reached | No |
| `agnt0 credits buy` / `agnt0 upgrade` | Open the credit packs / plans page | No |

Global options: `--api <url>`, `--version`, `--help`.

## Projects made by the web guide

The guide on the web app creates your project for you. Attach this folder to it with:

```sh
agnt0 init --project prj_…     # new folder (runs git init)
agnt0 link --project prj_…     # existing repo
```

Without `--project`, in an interactive terminal, `init` and `link` list the projects your account
already has and ask whether to use one or create a new one (Enter picks the newest, or "new" when you
passed a name). In scripts and CI (no TTY) they always create a new project.

## How `agnt0 run` works

1. Sends a heartbeat every 30 seconds and asks `POST /v1/projects/{id}/steps/next` for work. The
   project's `dev` env vars are loaded once (if it has any) and added to the runner's environment;
   keys that would change your own runner login (`ANTHROPIC_*`, `CLAUDE_*`, `CODEX_*`, `OPENAI_API_KEY`, …)
   are never passed to Claude Code / Codex.
2. For a step: takes a checkpoint (`refs/agnt0/checkpoints/<step>`) when asked and records it on the
   dashboard, creates or reuses the ticket's git worktree under `.agnt0/wt/`, and runs
   `claude -p --output-format stream-json --verbose --max-turns … --model … --permission-mode acceptEdits --allowedTools …`
   with the step prompt on stdin.
3. Tool calls, edits and messages stream to the dashboard every 2 seconds. Token usage is read from
   Claude Code's own output.
4. The work is committed on the ticket branch (`agnt0: <ticket> <role>`) and the outcome, diff stats
   and usage are reported.
5. When idle it prints why and exits (`--watch` keeps polling). When every ticket is done it prints a
   one-line summary: tickets done, credits used and the `agnt0/<ticket>` branches still to merge
   (merging is the Release Manager's job, not done automatically yet). When a usage limit is reached it
   pauses, prints the reset time and how to keep going (`agnt0 credits use`, `agnt0 upgrade`), and
   exits 0. Ctrl-C reports the current step as interrupted.

Audit steps (the Code Auditor) are read-only: they run in the repo root with no worktree, checkpoint
or commit, and finish with a one-line summary (`Code health 72/100 · 3 findings · dead code 2 …`) and a
link to the Code health page. After `agnt0 link`, the API queues an audit of the existing code, so the
first `agnt0 run` audits before the Planner writes tickets (`agnt0 audit --skip` to skip it).

With `--watch`, `agnt0 run` also listens for rollback requests from the dashboard and prints the
`agnt0 rollback <id>` command to run; it never rolls back on its own.

Step prompts are kept in memory only; they are never written to disk or logs.

## Checkpoints and rollback

```sh
agnt0 checkpoint "before the redesign"   # refs/agnt0/checkpoints/user/<time>-before-the-redesign
agnt0 checkpoints                        # list (agent checkpoints from `run` show up here too)
agnt0 rollback ckp_…                     # asks first; --yes in scripts
```

A checkpoint is a commit of the whole working tree (uncommitted and untracked files included, ignored
files excluded) made through a throwaway index, so taking one never touches your files, index or
branch. `rollback` never deletes anything: it first takes a pre-rollback checkpoint of everything as
it is, then switches to a new branch `agnt0/rollback-<time>` and commits the restored tree there. Your
previous branch is untouched (`git switch <branch>` to go back) and untracked files stay where they are.
Checkpoints made on another machine aren't in your repo until you fetch their refs.

## Environment variables

`agnt0 env pull` fetches the project's env vars (set on the dashboard) and prints how many there are and
their names; values are never printed or logged. `agnt0 run` and `agnt0 preview` inject the `dev` set
into what they start on their own. `agnt0 env pull --write` writes them to `.env.local` with mode 0600
(merging with what's there) and adds it to `.gitignore` if git doesn't already ignore it; it refuses if
`.env.local` is tracked. `agnt0 env pull -- npm test` runs one command with the vars injected.

## Preview

`agnt0 preview` reads `package.json`, picks how to start the dev server (Expo → `expo start`, Next.js,
Vite, or the `dev` script, with your package manager from the lockfile), injects the dev env, waits for
it to answer, then serves the preview page from the CLI on `http://localhost:4400` (or the next free
port) and opens it. The page is bundled into the CLI (no network requests): mobile 390×844, tablet
820×1180 and desktop 1440-wide frames, rotate, reload, a path field and keys `1` `2` `3` / `R`. Hot reload
is your dev server's own. For Expo it shows the `exp://` link with a QR code for Expo Go. The status
(starting / running / stopped / error) is reported to the dashboard, which embeds the preview on the
same machine. Ctrl-C stops the dev server and the page. Already running a dev server? `--url
http://localhost:5173`. Preview is free and keeps working when a usage limit is reached.

## QA

`agnt0 qa` tests the running preview (or starts the dev server itself, or `--url`). It opens a QA run
(charged like a QA step; a usage limit pauses it like `run`), then headless Chromium visits each page at
each device size, takes a full-page screenshot and collects findings automatically: console errors,
uncaught page errors, failed requests and 4xx/5xx responses, horizontal overflow at the device width,
broken images and a missing `<title>`. Screenshots go up through short-lived signed URLs (and stay in
`.agnt0/qa/<run>/`); findings come with severity, repro steps and their screenshot, and medium/high ones
become bug tickets on the board. It prints a page × device summary and the results link.

QA needs Chromium. The first run asks to install it (`npx playwright install chromium`, about 150 MB,
once); `--yes` installs without asking. An existing Playwright Chromium (`PLAYWRIGHT_BROWSERS_PATH`) is
used as is.

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
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default | Where `agnt0 qa` looks for (and installs) Chromium |
| `DEBUG=agnt0` | – | Verbose logs and stack traces |

## License

Elastic License 2.0. See `LICENSE` and `THIRD_PARTY_NOTICES`.
