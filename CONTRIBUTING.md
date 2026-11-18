# Contributing to JobFlow

Thanks for helping! JobFlow is a self-hostable job-search platform: discovery across ATS
boards and feeds, honest match cards, grounded résumé tailoring and an autofill that always
stops at a human review gate. This guide gets you from clone to pull request.

## Ground rules (the invariants)

These are the product's promises. A change that breaks one will not be merged, however
useful it is otherwise.

1. **Tier boundary.** The cloud worker, the web server and the cron run only Tier 1–2
   sources. Tier 3 (`packages/adapters/src/tier3/` — LinkedIn, Naukri, Glassdoor,
   AmbitionBox, Darwinbox) runs only in the local agent on the user's machine. Never register
   a Tier-3 adapter in the cloud registry, and never add a server path that holds a user's
   session for those sites.
2. **The form-filler never submits.** `packages/autofill` has no code path that clicks
   submit, presses Enter on a form or dispatches a submit event. `JOBFLOW_AUTOSUBMIT` is
   hard-false and `assertNeverSubmits()` throws if it isn't.
3. **Generation is grounded in the candidate's own material.** Résumé bullets, answers and
   cover letters may rephrase, reorder and trim the user's résumé, Evidence Bank and declared
   skills — never extend them. Every generation path passes `HONEST_VOICE`, the candidate
   block and the evidence block; when a model is unavailable, documents fall back to
   deterministic builders labelled `builtin` and prose refuses. Résumé import copies spans
   from the source and filters any model output through `groundDraft`.
4. **Almost nothing is a hard filter.** Stack, seniority and location are weighted signals
   with honest flags. The only hard exclusions live in `hardExclude()`
   (`packages/core/src/match/score.ts`). Saved-search *views* are the user's explicit choice:
   they hide only on confidently-known values, never change a score, and always report
   what they hid.
5. **Idempotent upserts + honest freshness.** Postings key on `(atsType, atsJobId)`;
   non-ATS sources use a source-prefixed `scopedJobId`. Never mark postings stale from a
   partial or failed fetch.
6. **One type system.** Shared shapes come from `@jobflow/core` (Zod). Don't redefine
   `Posting`, `Match`, `Profile` and friends locally.
7. **Tenant isolation.** Every tenant-scoped read and write takes the caller's tenant id.
   API routes resolve the caller with `guard()` / `withAuth()` — `scripts/check-tenant.mjs`
   enforces it in CI.

## Development setup

Requirements: Node 20+ (22 recommended) and pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm demo          # the whole pipeline against live public APIs, as a fictional candidate (~1 min)
pnpm web           # http://localhost:3000
```

No database or API keys are needed: storage defaults to in-memory (web) or PGlite under
`~/.jobflow` (CLI), and the `echo` LLM provider runs offline. See
[docs/configuration.md](docs/configuration.md) for every setting.

### Repository layout

```
packages/
  core/       Zod schemas + pure domain logic: normalize, dedup, match, salary, résumé parsing
  adapters/   one SourceAdapter per job source, tier-tagged; ATS detector; Tier-3 (local only)
  db/         Repository interface, in-memory + Postgres/PGlite implementations, migrations
  llm/        swappable providers + grounded generation + re-rank
  pipeline/   orchestration: ingest, discover, poll, presets, searches, profile import
  resume-io/  bytes → résumé text (PDF, DOCX, LinkedIn export)
  service/    application services shared by web, CLI and worker (feed, tailor, onboarding)
  autofill/   Playwright form-filler with a review gate (never submits)
apps/
  web/        Next.js control plane
  cli/        the `jobflow` command
  worker/     cloud job runner (Tier 1–2 only)
  agent/      local agent (Tier 3 + form fill, on your machine)
  extension/  MV3 browser extension (read-only capture + match panel)
```

Dependencies point inwards: `core` depends on nothing; `adapters`, `db`, `llm`, `autofill`
and `resume-io` depend only on `core`; `pipeline` composes `core` + `adapters` + `db`;
`service` adds `llm` and `resume-io`; apps compose everything.

### Conventions

- ESM with `.js` import specifiers in TypeScript source (`import { x } from "./foo.js"`).
- Strict TypeScript with `noUncheckedIndexedAccess` — handle `undefined` on index access.
- Pure functions in `core`; adapters are thin classes implementing `SourceAdapter`.
- Adapters return `[]` on recoverable errors and never throw the pipeline.
- Comments explain *why*, not *what*.
- Tests use **fictional** people and companies (`example.com` addresses). Never commit a real
  résumé, name, email, token or screenshot of real data — `scripts/check-pii.mjs` runs in CI.

## Common changes

### Add a job source

1. Create `packages/adapters/src/<group>/<name>.ts` implementing `SourceAdapter`
   (`source`, `tier`, `fetch`; `isLive` if the source has a per-job endpoint that says
   "gone" definitively; `toTargets` + `searchCaps` if it supports search queries).
2. Register it in `packages/adapters/src/registry.ts` — unless it's Tier 3, in which case it
   goes in `tier3/` and is **not** registered for the cloud.
3. Add its trust prior to `SOURCE_TRUST` in `packages/core/src/match/trust.ts` (and
   `REDATED_SOURCES` if it re-stamps dates).
4. Add a fixture-based test — no live HTTP in tests.

Open a "New job source" issue first if you're unsure which tier it belongs to.

### Add an ATS to the detector

Add a URL pattern and a `probe()` case in `packages/adapters/src/detector/index.ts`, with a
test.

### Add a discovery preset

Presets are data in `packages/pipeline/src/presets/`. Use stable feed ids (users can turn
individual feeds off) and prefer well-known public boards.

### Change matching

Weights and components live in `packages/core/src/match/score.ts`; keep each component in
`[0, 1]` and the weights summing to ≈ 1. Add tests for the behaviour you're changing.

### Change a generator or prompt

Keep `HONEST_VOICE`, and bump `PROMPT_VERSION` (`packages/service/src/tailor.ts`) so drafts
made by the old prompt read as stale.

### Add a database field

Add a numbered migration in `packages/db/migrations/` (idempotent, with RLS for tenant
tables), update both `InMemoryRepository` and `PgRepository`, and extend the contract test in
`packages/db/test/contract.test.ts` — it runs against both stores.

## Licensing of contributions

JobFlow is licensed under the [GNU AGPL-3.0-only](LICENSE). By submitting a contribution you
agree that it is licensed under the same terms (inbound = outbound), and you certify the
[Developer Certificate of Origin](https://developercertificate.org/) — that you wrote it or
otherwise have the right to submit it. Sign off each commit with `git commit -s`, which adds a
`Signed-off-by:` line. Don't contribute code copied from projects under incompatible licences.

## Pull requests

- Keep PRs focused; describe the user-visible change and how you tested it.
- `pnpm -r build && pnpm -r typecheck && pnpm -r test` must pass, plus
  `node scripts/check-pii.mjs` and `node scripts/check-tenant.mjs`.
- Fill in the invariants checklist in the PR template.
- Commit messages: imperative mood, a short summary line, and a body that explains why;
  signed off (`git commit -s`).

## Reporting security issues

Please don't open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
