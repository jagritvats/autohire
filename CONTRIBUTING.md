# Contributing to JobFlow

Thanks for being here. JobFlow is a local-first job search engine. It finds roles across
company job boards and feeds, ranks them against your own résumé with honest match cards,
tailors your documents from your own material, and pre-fills applications up to a review
screen where **you** press submit. It runs on your machine as a CLI and a web app, with an
optional multi-user hosting mode.

This page is the front door. It gets you from clone to pull request. The deeper guides are
in [docs/contributing/](docs/contributing/).

## Our promises

JobFlow makes a few promises to the people who use it. A change that breaks one won't be
merged, however useful it is otherwise. The full text, with the functions that enforce
each rule, is in [CLAUDE.md](CLAUDE.md#invariants-do-not-break-these).

1. **Logged-in sites stay on your machine.** The web server, worker and cron run only Tier 1–2
   sources. LinkedIn, Naukri, Glassdoor and the other Tier-3 sources run only in the local
   agent, in your own browser session.
2. **The form-filler never submits.** There is no code path, option or command that submits
   an application.
3. **Generated text is grounded in your own material.** Tailored résumés, letters and
   answers rephrase, reorder and trim your résumé, Evidence Bank and declared skills. They
   never add to them.
4. **Almost nothing is a hard filter.** Stack, seniority and location are weighted signals
   with honest flags. There are exactly two hard exclusions. Views say what they hid.
5. **Postings are upserted idempotently and kept fresh honestly.** Nothing is retired on a
   failed or partial fetch.
6. **One type system.** Shared shapes come from `@jobflow/core`.
7. **Your data is yours.** Every tenant-scoped read and write takes the caller's tenant id.
   New users start blank, and no real personal data is ever committed.

## Ways to contribute

- **Job sources.** A new board, ATS or feed is one adapter plus one registry line. See
  [Adding a job source](docs/contributing/adding-a-job-source.md).
- **ATS detection.** Teach the detector a new careers-site URL pattern
  (`packages/adapters/src/detector/index.ts`).
- **Discovery presets.** Better seed employers and feeds for a market. See
  [Presets and discovery](docs/contributing/presets-and-discovery.md).
- **Parsing and normalization.** Titles, skills, locations, salaries, experience
  (`packages/core/src/normalize/`) and résumé import (`packages/core/src/resume/`). This is
  where match quality is won. Add tests with every change.
- **UI and UX.** The web app follows a small design system and a set of UX rules. See
  [Working on the web UI](docs/contributing/web-ui.md).
- **The CLI.** See [Working on the CLI](docs/contributing/cli.md).
- **Docs.** Fix what confused you. User docs are in [docs/](docs/README.md).
- **Translations.** All copy is English today and lives inline in components and commands;
  there is no translation layer yet. If you'd like to add one, open an issue first so we can
  agree on the approach.
- **Bug reports and ideas.** Use the [issue forms](.github/ISSUE_TEMPLATE/). Output from
  `jobflow doctor --json` helps a lot. Never paste keys, tokens, cookies or a résumé.

### Good first issues

Each of these is small, self-contained and has an existing example to copy:

- **Poll Recruitee and Personio boards.** Both are in `AtsType` and the detector already
  recognises their URLs, but neither has an adapter in `ADAPTERS`, so a detected board is
  never polled. Model it on `packages/adapters/src/ats/lever.ts`.
- **Add RemoteOK or Jobicy.** Both have a `SourceKind`, a trust prior and a
  `REDATED_SOURCES` entry in `packages/core/src/match/trust.ts`, but no adapter. Model it on
  `packages/adapters/src/aggregators/remotive.ts`.
- **Finish the copy pass.** `CompaniesView`, `EvidenceEditor` and `TokensPanel` in
  `apps/web/components/` still use pre-overhaul wording
  ([UX_AUDIT.md](docs/internal/UX_AUDIT.md), "Still open").
- **Move markup to canonical classes.** Legacy names such as `.card-block`, `.save` and `.cmd`
  are aliased in `apps/web/app/globals.css`. Converting a component to the primitives in
  `apps/web/components/ui/` is a tidy, reviewable change.
- **Teach the normalizer a skill or title.** Add an alias to `SKILL_ALIASES` in
  `packages/core/src/normalize/skills.ts` (or a title pattern in `titles.ts`) with a test in
  `packages/core/test/normalize.test.ts`.

Look for the `good first issue` label on GitHub too. Unsure whether something fits? Open an
issue or a discussion before you write a lot of code.

## Development setup

You need **Node 22** (Node 20 works; CI uses 22) and **pnpm 9**. Corepack installs the right
pnpm from `package.json`:

```bash
corepack enable
git clone https://github.com/jagritvats/autohire.git jobflow && cd jobflow
pnpm install
pnpm -r build          # tsc -b across packages, plus the Next.js build
pnpm -r test           # vitest, offline
```

No database, API keys or model are needed. Storage defaults to PGlite (Postgres in WASM) in
`~/.jobflow`, and the offline `echo` model stands in for an LLM.

Then run it:

```bash
pnpm jobflow                     # the CLI: shows where you are and the next step
pnpm jobflow --help
pnpm web                         # web app dev server on http://localhost:3000
pnpm jobflow serve               # the web app on the same data as the CLI
pnpm demo                        # the whole pipeline against live public APIs, fictional persona, in memory
```

### Keep development data apart

The CLI and web app share one data directory, and PGlite allows one writer at a time. Use a
scratch directory while developing so you never touch, or lock, your own job search:

```bash
export JOBFLOW_DATA_DIR="$(mktemp -d)"     # or: pnpm jobflow --data-dir /tmp/jf-dev …
pnpm jobflow init --yes --sample           # the fictional sample persona
```

For UI work, demo mode serves an offline, fictional corpus and saves nothing:

```bash
JOBFLOW_DEMO_DATA=1 JOBFLOW_STORE=memory pnpm web
```

Every setting is in [docs/configuration.md](docs/configuration.md).

## How the code is laid out

```
packages/
  core/       Zod schemas (the one type system) + pure logic: normalize, dedup, match, views, salary, résumé parsing
  adapters/   one SourceAdapter per source, tier-tagged; search targets; ATS detector; SSRF guard; tier3/ (local only)
  db/         the Repository interface; in-memory, PGlite and Postgres stores; migrations with RLS; file store
  llm/        providers (Anthropic, OpenAI-compatible, echo), grounded generation, re-rank, résumé extraction
  pipeline/   discover, poll, ingest, liveness, presets, the discovery plan, search, salary estimates
  resume-io/  file bytes → résumé text (PDF, DOCX, LinkedIn export)
  service/    what the CLI, web app and worker share: feed, search, discovery, onboarding, tailoring, apply plan
  autofill/   the Playwright form-filler, which stops at the review gate
apps/
  cli/        the `jobflow` command
  web/        Next.js UI and API
  worker/     scheduled discover → poll → rank for hosted setups (Tier 1–2 only)
  agent/      the local agent: Tier-3 sources and form filling, on your machine
  extension/  MV3 browser extension: match panel and page capture (read-only)
scripts/      CI guards (check-pii, check-tenant), screenshots, dev helpers
docs/         user docs; docs/contributing/ for contributors; docs/internal/ for design notes
```

Dependencies point inwards:

```
core                                     depends on nothing
adapters · db · llm · autofill · resume-io → core
pipeline                                 → core, adapters, db
service                                  → pipeline, llm, resume-io, autofill (and what they use)
apps/cli · apps/web · apps/worker        → service and the packages
apps/agent                               → pipeline, autofill, llm (no service)
```

Nothing points outwards: `core` never imports another package, and `pipeline` never imports
`llm` (it is handed an embedder instead). Put app logic in `packages/service`, not in
`apps/web/lib` or a CLI command, so every interface gets it.
[docs/architecture.md](docs/architecture.md) explains the pipeline and the two planes.

### Conventions

- ESM with `.js` import specifiers in TypeScript (`import { x } from "./foo.js"` for
  `foo.ts`).
- Strict TypeScript with `noUncheckedIndexedAccess`: handle `undefined` on index access.
- Pure functions in `core`. Adapters are thin classes that return `[]` on recoverable errors
  and never throw into the pipeline.
- Comments explain *why*. Older comments cite the original design spec as `(§N)`.
- Tests and fixtures use fictional people and companies at `example.com`.

## Checks

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every pull request, offline,
with Node 22. Run the same locally before you push:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r test
node scripts/check-pii.mjs       # no real personal data in tracked files
node scripts/check-tenant.mjs    # every API route resolves its caller; no hard-coded tenant
```

After changing `core`, `adapters` or `pipeline`, also run `pnpm demo`. It hits live free APIs
and catches integration breaks that offline tests can't. See
[Testing](docs/contributing/testing.md) for how the suites are organised.

## Commits and pull requests

- **Sign off every commit** with `git commit -s`. This adds a `Signed-off-by:` line and
  certifies the [Developer Certificate of Origin](https://developercertificate.org/): you
  wrote the change or otherwise have the right to submit it. Maintainers check sign-offs
  during review.
- **Licensing.** JobFlow is [AGPL-3.0-only](LICENSE). Contributions are accepted under the
  same licence (inbound = outbound). Don't copy code from projects under incompatible
  licences.
- **Commit messages.** A short summary in the imperative, often prefixed with the area
  ("Sources: show each source's last run"), then a body that explains why.
- **One topic per pull request.** Describe the user-visible change and how you tested it, and
  fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist.
- **UI changes** include screenshots in light and dark, and at mobile width when layout
  changes. **CLI changes** update the help text, keep `--json` working, and update
  [docs/cli.md](docs/cli.md).
- Add a line to the [CHANGELOG](CHANGELOG.md) under `## [Unreleased]` for anything users
  will notice.

## What to expect in review

Reviewers check, in this order:

1. **The promises above.** Tier boundary, never-submit, grounding, soft ranking, idempotent
   upserts, one type system, tenant isolation and privacy. These aren't negotiable.
2. **Tests** for the behaviour you changed, using fictional data and no live HTTP.
3. **Honest UX.** Views report what they hide, empty and error states say what to do next,
   estimates look like estimates.
4. **Scope and placement.** Logic in the right package, no drive-by refactors.

Expect questions and requests for changes; it's normal, and it's how the codebase stays
coherent. If a review stalls, a polite ping on the pull request is welcome.

## Deeper guides

| Guide | For |
|---|---|
| [Adding a job source](docs/contributing/adding-a-job-source.md) | adapters, tiers, search targets, liveness, the SSRF guard, fixture tests |
| [Presets and discovery](docs/contributing/presets-and-discovery.md) | preset data, stable feed ids, the discovery plan, preset tags |
| [Working on the web UI](docs/contributing/web-ui.md) | design system, primitives, page structure, accessibility, UX rules, screenshots |
| [Working on the CLI](docs/contributing/cli.md) | commands, output and `--json`, exit codes, row references, in-process tests |
| [Data, storage and migrations](docs/contributing/data-and-migrations.md) | the Repository, stores, migrations and RLS, contract tests, tenant isolation |
| [Testing](docs/contributing/testing.md) | where tests live, fixtures, the real-browser autofill test, live checks |
| [Releasing](docs/contributing/releasing.md) | versions, the CHANGELOG, cutting a release |

## Security and conduct

Please don't open public issues for vulnerabilities. Report them privately as described in
[SECURITY.md](SECURITY.md). Anything that could make the form-filler submit, let the server
run a Tier-3 source, or cross tenants is a security bug.

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
