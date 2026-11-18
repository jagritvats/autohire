# Working on the CLI

`apps/cli` is the `jobflow` command: local-first, single-user, no server. It is a thin layer
of [commander](https://github.com/tj/commander.js) commands over `@jobflow/service`. The
user reference is [docs/cli.md](../cli.md). This guide is for changing the CLI.

```bash
pnpm jobflow --help                    # runs apps/cli/src/main.ts through tsx: no build step
pnpm -s jobflow --json status          # -s keeps pnpm's banner out of piped output
pnpm --filter @jobflow/cli test
```

Use a throwaway data directory while you develop, so you don't touch your own job search:
`pnpm jobflow --data-dir /tmp/jf-dev …`, `JOBFLOW_DATA_DIR=/tmp/jf-dev`, or `--store memory`
for nothing on disk at all.

## Layout

| File | Role |
|---|---|
| `apps/cli/bin/jobflow.mjs` | launcher: registers tsx and imports `src/main.ts` |
| `apps/cli/src/main.ts` | runs one invocation and sets the exit code |
| `apps/cli/src/program.ts` | `buildProgram()` builds the command tree fresh each run; `runCli()` maps errors to exit codes |
| `apps/cli/src/context.ts` | `Ctx`: global flags, data dir, the lazily opened repository, `cli.json` state, prompts |
| `apps/cli/src/output.ts` | `Out`: stdout vs stderr, `--json`, colour, tables, spinners |
| `apps/cli/src/errors.ts` | `EXIT` codes, `CliError` and the `usage` / `notFound` / `needsSetup` helpers |
| `apps/cli/src/refs.ts` | posting references: row numbers, ids, id prefixes |
| `apps/cli/src/commands/*.ts` | one module per command group, each exporting `register(program, ctx)` |
| `apps/cli/src/commands/shared.ts` | option parsers (`csv`, `presetIds`, `countryCode`, `money`, `skills`…) and `requireProfile` |
| `apps/cli/src/render/` | card and table rendering |

## Adding a command

1. Put the logic in `packages/service` (or `pipeline`/`core`), taking `(repo, tenantId, …)`,
   so the web app can use it too. The CLI command only parses, calls and prints.
2. Create `apps/cli/src/commands/<name>.ts` with `export function register(program, ctx)`,
   and call it from `buildProgram()` in `program.ts`.
3. Get the repository with `await ctx.repo()` (it opens and migrates on first use, so
   commands that don't need it never take the PGlite lock) and use `ctx.tenantId`.
4. Print through `ctx.out` (below), and throw `CliError`s for failures.
5. Document it in [docs/cli.md](../cli.md) and add tests.

There is **no option or command that submits an application**, and there never will be
(invariant #2). `apps/cli/test/cli.test.ts` walks the whole command tree and fails if any
command name, alias or option mentions "submit". Don't name things in a way that trips it.

## Output contract

Data goes to **stdout**. Everything else (progress, prompts, hints, warnings) goes to
**stderr**, so `jobflow … --json | jq` always gets clean JSON.

| Method | Stream | With `--json` |
|---|---|---|
| `out.emit(data, human)` | stdout | prints `data` as one JSON document; `human` is skipped |
| `out.line()`, `out.ok()`, `out.table()` | stdout | suppressed (the JSON is the data) |
| `out.note()`, `out.hint()` | stderr | suppressed |
| `out.warn()` | stderr | still shown |
| `out.spinner()` | stderr (animated only on a TTY) | no-op |

Every command that produces data must go through `emit`, so `--json` works everywhere. The
JSON shape is a public interface that scripts depend on: add fields freely, but treat
renaming or removing one as a breaking change and note it in the CHANGELOG.

Colour is on only for a TTY, and off with `NO_COLOR` or `--no-color`.

## Exit codes

Defined in `apps/cli/src/errors.ts` and part of the contract:

| Code | Helper | Meaning |
|---|---|---|
| 0 | | ok |
| 1 | `new CliError(msg)` | error: network, data dir busy, a failed compile, `doctor` found a failure |
| 2 | `usage(msg, hint)` | bad flag or value, unknown command or preset |
| 3 | `notFound(msg, hint)` | no such posting, row, saved search, file |
| 4 | `needsSetup(msg, hint)` | no profile yet, no generation model, form filling off |

`runCli()` also maps commander usage errors and `ZodError` to 2. A command that succeeds but
should still exit non-zero sets `ctx.exitCode`. Errors print as one line plus an optional
hint, never a stack trace (set `JOBFLOW_DEBUG=1` to see it).

## Hints and next steps

The CLI follows [clig.dev](https://clig.dev/): say what changed, then suggest the one thing
to run next.

- End a successful command with a `next:` hint (`out.hint("next: jobflow show 1 · …")`).
- An empty state says how to fill it ("Your corpus is empty." then `jobflow sync`).
- An error's hint names the exact command or flag that fixes it.
- Bare `jobflow` shows `status` (`apps/cli/src/commands/status.ts`), driven by the same
  `setupProgress()` checklist as the web app's Get started panel.
- Before `jobflow init`, output makes no profile-relative claims and hard-excludes nothing.

## Row references

After `feed`, `search` or `track`, `ctx.rememberListing(kind, ids)` stores the row order in
`<data dir>/cli.json`. `resolvePosting(ctx, ref)` (`apps/cli/src/refs.ts`) then accepts `3`
or `#3`, a full id, or a unique id prefix of four or more characters. A search result that
isn't in the corpus yet is saved and scored the moment it is referenced, so
`search → tailor 2 → apply 2` works. Commands that take a posting should take a `<ref>` and
call `resolvePosting`.

## Testing commands in-process

CLI tests run the real command tree in the same process, with captured output and a stubbed
network. Use the helpers in `apps/cli/test/helpers.ts`:

```ts
const tmp = tempDir();
const repo = new InMemoryRepository();
vi.stubGlobal("fetch", fakeFetch());            // Remotive answers, everything else is a 404

const r = await run(["--json", "feed"], { dataDir: tmp.dir, repo });
expect(r.code).toBe(0);
expect(r.json().cards).toHaveLength(0);
```

`run()` passes `--data-dir`, `--store memory` and `NO_COLOR=1`, and returns `{ code, out, err,
json() }`. Pass `stdin` to answer prompts. Pass the same `repo` to several `run()` calls to
test a journey. The existing tests also clear `LLM_PROVIDER` and friends in `beforeAll` so
generation runs on the offline echo provider.

For each change, test the exit code, the `--json` shape, and the human output's key line or
hint. `apps/cli/test/journeys.test.ts` holds first-run journeys; `apps/cli/test/cli.test.ts`
holds per-command tests, the exit-code table and the never-submit walk.

```bash
pnpm --filter @jobflow/cli test
pnpm --filter @jobflow/cli exec vitest run -t "never-submit"
```

## Checklist for a CLI change

- [ ] Logic in `packages/service`, not in the command
- [ ] `--json` works and goes through `out.emit`
- [ ] Right exit code; errors carry a hint
- [ ] `--help` text (`.description()`, option descriptions) is clear and matches
      [docs/cli.md](../cli.md)
- [ ] Nothing mentions or performs a submit
- [ ] In-process tests for the change
