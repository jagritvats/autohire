# Testing

JobFlow's tests run offline. CI has no secrets, no database server and no network access to
job boards, so every test uses the in-memory store or PGlite, stubbed HTTP and the offline
`echo` LLM provider. Live behaviour is checked separately with `pnpm demo`.

## Running tests

```bash
pnpm -r test                                            # every package (what CI runs)
pnpm --filter @jobflow/core test                        # one package
pnpm --filter @jobflow/core exec vitest run test/match.test.ts    # one file
pnpm --filter @jobflow/cli exec vitest run -t "never-submit"      # by test name
pnpm --filter @jobflow/core exec vitest                 # watch mode
```

Tests run against the TypeScript source: Vitest resolves the `.js` import specifiers to the
`.ts` files, so you don't need to build before testing. You do need
`pnpm -r build` before `pnpm -r typecheck` and before running the apps.

## Where tests live

Every package keeps its tests in `test/` (Vitest also picks up `src/**/*.test.ts` where the
config says so).

| Package | What its tests cover |
|---|---|
| `packages/core/test/` | normalization (titles, skills, location, salary, experience), scoring and hard exclusions, views, salary estimates, résumé parsing and grounding. Pure functions, so most of the suite lives here. |
| `packages/adapters/test/` | parsers on recorded payloads, stubbed `fetch`, `toTargets`, the SSRF guard, Tier-3 parsers |
| `packages/db/test/` | the repository contract (memory and PGlite), migrations, the data-dir lock, the file store, crypto, `.env` parsing |
| `packages/llm/test/` | providers, grounded tailoring (a stub `LlmProvider` records the request), extraction |
| `packages/pipeline/test/` | ingest, liveness, polling custom sources, presets, the discovery plan, search, salary |
| `packages/resume-io/test/` | PDF, DOCX and LinkedIn-export bytes to text |
| `packages/service/test/` | app journeys: setup checklist, feed, background sync, tracking |
| `packages/autofill/test/` | the fill plan, the never-submit guard, the real-browser fill |
| `apps/cli/test/` | the CLI run in-process |
| `apps/web/test/` | navigation, card text, auth resolution |

`apps/worker` and `apps/agent` have no test suite of their own; their logic lives in the
packages and is tested there. `apps/extension` is plain JavaScript with no build or tests.

## Rules for tests

- **No live HTTP.** Stub `fetch` with `vi.stubGlobal("fetch", …)` and undo it in `afterEach`
  (`vi.unstubAllGlobals()`), or test a pure parser on a saved payload. To stub one adapter
  in a pipeline test, replace `ADAPTERS.<source>.fetch` and restore it afterwards
  (`packages/pipeline/test/poll-custom.test.ts`).
- **Fictional data only.** Fixtures use invented people and companies with `example.com`
  addresses: "Sam Placeholder", "Example Corp", "Acme Pay". Never commit a real résumé, a
  real person's name, email or phone number, a token, or a posting that names a real
  recruiter. `scripts/check-pii.mjs` runs in CI.
- **The offline model.** Generation tests run on `echo` or a stub provider. Tests that go
  through the CLI clear `LLM_PROVIDER` first, so a key in your shell doesn't change results.
- **Time.** Pass `now` where a function takes it instead of mocking the clock.
- **One behaviour per test, named for the behaviour** ("an unscored search makes no claims
  about you and hides nothing"). The names read as the spec.

## Contract tests across stores

`packages/db/test/contract.test.ts` runs one suite (`describe.each`) against
`InMemoryRepository` and against `PgRepository` on PGlite in a temporary directory. Any
change to the `Repository` interface or either implementation needs a case here: round-trip,
idempotency, and isolation between two tenants. See
[data-and-migrations.md](data-and-migrations.md).

## The real-browser autofill test

`packages/autofill/test/browser-fill.e2e.test.ts` serves a Greenhouse-style application
form on a local HTTP server, fills it in real Chromium, and proves invariant #2: every field
is filled, the résumé is attached, the page never navigates, and the server counts **zero**
POSTs.

It runs only when Playwright can launch a Chromium, and is skipped otherwise (as on plain CI
runners). `pnpm install` already links Playwright (an optional dependency); the browser is a
separate download. To run it:

```bash
pnpm --filter @jobflow/autofill exec playwright install chromium   # once; or set JOBFLOW_CHROMIUM to a Chrome/Chromium
pnpm --filter @jobflow/autofill test
JOBFLOW_E2E_SCREENSHOT=/tmp/review-gate.png pnpm --filter @jobflow/autofill test   # also save a picture of the review gate
```

Run it whenever you touch `packages/autofill`. `packages/autofill/test/never-submits.test.ts`
always runs: it checks that autosubmit is hard-false and scans the source for anything that
clicks, presses or dispatches a submit.

## CLI tests

CLI tests build the real command tree and run it in the same process with captured output
(`run()` in `apps/cli/test/helpers.ts`). See [cli.md](cli.md#testing-commands-in-process).
`apps/cli/test/cli.test.ts` includes the walk that fails if any command or option mentions
"submit".

## Web tests

`apps/web/test/auth-resolve.test.ts` tests `resolveAuth` directly with plain request data:
single-user mode answers only loopback, same-origin requests; password mode needs a valid
session or token; cross-site writes are refused; one tenant can't revoke another's token.
Add a case for any change under `apps/web/lib/auth/`.

`apps/web/test/journeys.test.ts` pins the navigation (`NAV`, `activeNav`) and the
plain-language card text. Pages and components have no automated rendering tests; review
them visually ([web-ui.md](web-ui.md#screenshots-and-visual-review)).

## Live checks

Offline tests can't tell you that a board changed its API. Before merging a change to
`core`, `adapters` or `pipeline`, run the live smoke test:

```bash
pnpm -r build
pnpm demo        # about a minute: discover, poll, rank and tailor against live free APIs, in memory
```

It uses the fictional sample persona and an in-memory store, and leaves your data alone.
Expect the counts to vary from run to run. Look for errors, and for empty results from a
source you touched.

To exercise the CLI end to end against live boards, use a scratch data dir:

```bash
export JOBFLOW_DATA_DIR="$(mktemp -d)"
pnpm jobflow init --yes --sample
pnpm jobflow sync && pnpm jobflow feed
```

## What CI runs

`.github/workflows/ci.yml`, on every pull request and on pushes to `main`, with Node 22 and
`LLM_PROVIDER=echo`:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
node scripts/check-pii.mjs      # separate "guards" job
node scripts/check-tenant.mjs
```

Run the same before you push.
