# How the CLI talks

The commands look the same because they share a small set of pieces, not because everyone copies the
last one carefully. This is that set, and the rules that decide when to use which. It is short on
purpose: if a rule here needs a paragraph to justify, it is probably not a rule.

## The shape of a command's output

```
agnt0 doctor                        ← what ran, plain, no banner

✓  Node.js            v22.22.0      ← result, label, value: three columns, aligned
✓  git                git version 2.43.0
!  Codex login        not logged in

✓ Ready to build.                   ← the verdict, on its own
  Report sent to your account.      ← indented detail under it
```

- **No banners, no boxes, no spinners that outlive a second.** A command says what it did and stops.
- **One idea per line.** A line a person can stop reading after.
- **Values are never bare.** `0/1200 credits`, not `0`. `in 5d`, not a timestamp.

## The pieces

Everything lives in `src/ui.ts`. Use it rather than reaching for `picocolors` directly.

| Piece | Use it for |
| --- | --- |
| `sym.ok` `✓` | something that worked, or is true now |
| `sym.fail` `✗` | the thing the person asked for did not happen |
| `sym.warn` `!` | it worked, and something is worth knowing |
| `sym.dot` `·` | separating facts on one line |
| `table(rows)` | two or more columns that should line up |
| `meterBar(used, allowance)` | anything with a limit: credits, time, quota |
| `relTime(iso)` | "in 5d", "3m ago" — never a raw timestamp |
| `label(text)` | the dim left column of a key/value line |

Colour carries meaning, never decoration: green is done, yellow is attention, red is stopped, dim is
context. A line that would be the same in black and white is right.

## Errors

Every error is two lines: what happened, then what to do about it.

```
✗ Nothing is answering at http://localhost:5173.
  Start your app first (`agnt0 preview`), or point at it with --url.
```

- Throw `CliError(message, hint)`. The message is a fact, the hint is an action.
- **Never invent the reason.** If the server said why, print what the server said. (We got this wrong
  once: every 403 claimed the project belonged to another account, which sent people to `agnt0 link`
  for problems that had nothing to do with linking.)
- No stack traces unless `AGNT0_DEBUG=1`.

## Before something irreversible or public

Say what is about to happen, in the sentence before it happens:

```
Opening a public link to http://localhost:5173 on this machine.
Anyone with the address can reach it while this runs. Ctrl-C closes it.
```

The same goes for anything that spends credits, exposes a port, or writes outside the project.

## Secrets

Shown once, never logged, never in an error. When a command prints one, it says so on the same screen
and tells the person where to put it. Nothing that writes a transcript (the run log, the event feed)
may carry a token, a prompt, or an environment value.

## What a long-running command prints

`run`, `preview` and `qa` can go for minutes. They print:

1. A header line naming the project and where it is pointed.
2. One line per thing that actually happened — a step started, a file changed, an approval is waiting.
   Progress that only means "still alive" is not a thing that happened.
3. A closing summary with the numbers that matter: tickets done, credits used, what to do next.

Interleaved output from parallel agents is tagged with the ticket (`[9avwgh]`), because without it two
agents reading at once is unreadable.

## The full-screen view

`agnt0 watch` is Ink, and the only place with a layout. It follows the same colour rules; tiles are
bordered by status, and anything measured (tokens, credits, savings) is shown only when it is
measured — a zero we did not measure is a lie, so the field is left out instead.

## Adding a command

1. It does one thing a person would name.
2. `--list` and `--revoke` style flags beat separate verbs for things that come in sets.
3. It works without arguments inside a linked project, or tells the person exactly what to pass.
4. It has a smoke test with the API mocked (`test/*.test.ts`), including the failure a person is most
   likely to hit.
5. Its first run on a machine that is missing something says how to get that thing.
