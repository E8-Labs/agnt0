# Agent Zero

Agent Zero takes you from an app idea to a running, QA-checked prototype from your terminal.

It is a thin-client build system. The free `agnt0` CLI in this repo drives **your own** Claude Code
(or Codex) on your machine, while the Agent Zero cloud decides what happens next: phases, tickets,
role prompts, skills, reviews and usage. Every agent action shows up in the web dashboard, where you
can watch, approve and steer.

- **Bring your own model.** Steps run on your Claude Code or Codex subscription.
- **One step at a time.** The cloud hands the CLI a single step; the CLI runs it in an isolated git
  worktree, commits the work on the ticket branch and reports back.
- **Nothing proprietary here.** This repo has no prompts, routing rules or pricing logic. Without an
  Agent Zero plan the CLI can sign in, check your setup and show usage, and that's it.

## Install

```sh
npm i -g agnt0
```

Requires Node.js 20+, git and [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
(signed in).

## Quick start

```sh
npm i -g agnt0
agnt0 login     # confirm the code in your browser
agnt0 doctor    # Node, git, Claude Code login, free ports
agnt0 init      # create a project here, or attach to the guide's: agnt0 init --project <id>
agnt0 run       # start the build loop
```

Then `agnt0 watch` for a live terminal view, or `agnt0 open` for the dashboard. See
[packages/cli/README.md](packages/cli/README.md) for every command.

## Develop from source

```sh
pnpm install
pnpm --filter agnt0 build
npm i -g ./packages/cli         # or: cd packages/cli && npm link
agnt0 --version
```

Point the CLI at a local API with `AGNT0_API_URL=http://localhost:8787` (the default) or `--api <url>`.

```sh
pnpm typecheck     # all packages
pnpm test          # vitest
```

## Repo layout

| Path | What |
| --- | --- |
| `packages/protocol` | `@agnt0/protocol`: zod schemas for every request and response, plus the route table. The wire contract with the cloud. |
| `packages/cli` | The `agnt0` binary: TypeScript, commander, Ink. Bundled with tsup; `@agnt0/protocol` is inlined so the npm tarball is standalone. |

## License

[Elastic License 2.0](LICENSE). Third-party notices in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
