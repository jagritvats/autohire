# CLAUDE.md — working in the JobFlow codebase

Guidance for Claude Code (and humans) working here. Read the **invariants** first — they're the things that, if violated, break the design's core promises.

## What this is

A full-TypeScript pnpm monorepo: a **local-first** job discovery → prep → assisted-apply platform (CLI + web), with an optional multi-user hosting mode. Three priorities, in order: **job finding**, **honest recommendations**, **autofill up to a review gate**. Architecture: `docs/architecture.md`; user docs: `docs/`; contributor guides: `CONTRIBUTING.md` + `docs/contributing/`; the original design rationale (cited as `(§N)` in comments) is in `docs/internal/`.

## Invariants (do not break these)

1. **Tier boundary is sacred.** The cloud (anything in `apps/worker`, `apps/web` server code, the cron) runs **only Tier 1–2** adapters. Tier 3 (`packages/adapters/src/tier3/`: Naukri, AmbitionBox, Glassdoor, LinkedIn) runs **only on the local agent**. Never register a Tier-3 adapter in `ADAPTERS`/`cloudAdapters()`. Never add a server code path that holds a user's LinkedIn/Naukri/Glassdoor session.
2. **The form-filler never submits.** `packages/autofill` has no code path that clicks submit. `JOBFLOW_AUTOSUBMIT` is hard-`false` in `readFlags()`; `assertNeverSubmits()` throws if it's somehow true. The review screen *is* the value. Don't add a submit step.
3. **Generation is grounded in the candidate's own material.** Every résumé bullet / answer / cover letter rests on the base résumé (`masterResume` / `resumeLatex`), the Evidence Bank, or declared skills — rephrased, reordered, trimmed, never extended. The `HONEST_VOICE` system prompt (`packages/llm/src/prompts.ts`) is mandatory on all generation. No name-dropping unknowns, no tryhard framing. If you add a generation path, pass `HONEST_VOICE`, `candidateBlock()`, and the evidence block. Never pass echo output off as a draft: documents fall back to deterministic builders labelled `builtin`, prose refuses.
4. **Almost nothing is a hard filter.** Stack/seniority/location are *weighted signals with flags*, not gates. The only two hard exclusions live in `hardExclude()` (`packages/core/src/match/score.ts`): salary-below-floor (high-confidence only) and impossible-location (onsite abroad with no sponsorship + relocation off, or a remote role *explicitly* restricted — confidence ≥ 0.85 — to a geo outside the user's `remoteGeoOk`). Don't add hard filters; add a weighted component + an honest flag instead.
5. **Idempotent upserts + freshness.** Postings key on `(atsType, atsJobId)`; non-ATS sources get a source-prefixed id (`scopedJobId`) so feeds can't collide on `unknown`. Re-polling upserts and bumps `lastSeen`; disappeared board postings are soft-deleted via `markStale` (diffed against the FULL board — never a truncated or failed fetch); non-board postings expire via the `FEED_TTL_DAYS` lastSeen sweep in `pollAll`; the between-polls liveness check (`checkLiveness`) retires a posting only on a DEFINITIVE per-job "gone" (404/410 or the board's own closed flag) — never on an error. Freshness scores the source's `postedAt` (the EARLIEST one we've seen — the upsert keeps `least()`, since boards re-stamp reposts), capped by `firstSeen`. Don't introduce duplicate inserts.
6. **One type system.** All shared shapes come from `@jobflow/core` (Zod). Don't redefine `Posting`/`Match`/`Profile` locally; import them.
7. **Tenant isolation + no built-in persona.** Every tenant-scoped repo call takes the CALLER's tenant id; web routes get it from `guard()`/`withAuth()` (`apps/web/lib/auth`), never `DEFAULT_TENANT` (`scripts/check-tenant.mjs` enforces). New users start from `blankProfile()`; the fictional `sampleProfile()` is only for demo/tests/screenshots. Never commit real personal data (`scripts/check-pii.mjs`).

## Layout & dependency direction

```
core                                       depends on nothing
adapters · db · llm · autofill · resume-io → core
pipeline                                   → core, adapters, db
service                                    → pipeline, llm, resume-io, autofill
mcp                                        → service (MCP server for agents; `jobflow mcp`; no form filling)
apps/*                                     → service + packages (agent: no service)
```

- `packages/core` depends on nothing (pure logic + Zod). Put domain logic here; keep it pure and unit-testable.
- `packages/adapters`, `db`, `llm`, `autofill` depend on `core` only.
- `packages/pipeline` orchestrates `core` + `adapters` + `db` (and is handed an `Embedder`/`LlmProvider`). Discovery presets are data in `pipeline/src/presets/`; `resolveDiscoveryPlan` unions presets + custom sources + saved searches across tenants.
- `packages/resume-io` (bytes → résumé text) and `packages/service` (feed, search, discovery, onboarding, tailoring, apply plan — everything the CLI, web and worker share; takes `(repo, tenantId, …)`). Put app logic here, not in `apps/web/lib`.
- `apps/*` compose everything. Seed registry in `pipeline/src/seed.ts`; blank/sample profiles in `seed.ts` / `sample.ts`.

## Conventions

- **ESM + `.js` import specifiers** in source (e.g. `import { x } from "./foo.js"` where the file is `foo.ts`). This is deliberate (NodeNext-style). The web app's `next.config.mjs` has an `extensionAlias` so webpack resolves `.js`→`.ts`.
- **Adapters return `[]` on recoverable errors**, never throw the pipeline. Use the `httpJson` helper (timeout + polite UA).
- **Pure functions over classes** in `core`. Adapters are thin classes implementing `SourceAdapter`.
- Comments explain *why* and cite the spec section (e.g. `(§11.3)`), not *what*.
- TS is strict with `noUncheckedIndexedAccess`. Expect to handle `undefined` on array access.

## Common tasks

- **Add a job source:** new file in `packages/adapters/src/<group>/`, implement `SourceAdapter` (`source`, `tier`, `fetch`, and `isLive` if the source has a per-job endpoint that says "gone" definitively), register in `registry.ts`, add its prior to `SOURCE_TRUST` (`core/src/match/trust.ts`; `REDATED_SOURCES` if its dates are re-stamped). If Tier 3, put it in `tier3/` and do **not** register it in `ADAPTERS`. One adapter, zero pipeline change.
- **Add an ATS to the detector:** add a URL pattern + a `probe()` case in `packages/adapters/src/detector/index.ts`.
- **Tune matching:** weights + components in `packages/core/src/match/score.ts`; stack adjacency graph in `match/stack.ts`. Keep components in `[0,1]`; weights sum ≈ 1.
- **Improve normalization:** `packages/core/src/normalize/` (titles, skills, location, salary). This is where quality is won — add tests when you touch it.
- **Salary:** `posting.salary` is only what the posting STATES (`normalize/salary.ts`; `high` needs an attached currency + a range/cap + a pay word or a salary field — it's what the hard floor acts on). Modeled pay lives in `posting.salaryEstimate`, never in `salary`: pure math in `core/src/salary/` (market ladders, FX, blend, calibration), evidence + persistence in `pipeline/src/salary.ts`. After changing either, run `pnpm --filter @jobflow/worker salary` (re-parse + re-estimate, idempotent) and `pnpm --filter @jobflow/worker salary-backtest` (leave-one-out error by confidence bucket — keep it monotonic).
- **Swap/add an LLM provider:** implement `LlmProvider` in `packages/llm/src/providers/`, wire in `factory.ts`. Keep `embed()` falling back to `localEmbed`.
- **Add a DB field / table:** numbered migration in `packages/db/migrations/` (idempotent; RLS on tenant tables), implement in BOTH `memory.ts` and `postgres.ts`, extend `packages/db/test/contract.test.ts` (runs against in-memory and PGlite). Storage: `createRepository()` picks `DATABASE_URL` → `JOBFLOW_STORE` → PGlite under `JOBFLOW_DATA_DIR` → memory; the CLI and the web app (`apps/web/lib/repo.ts`) default to PGlite in `~/.jobflow` so they share one durable store.
- **Add a CLI command:** `apps/cli/src/commands/*.ts`, calling `@jobflow/service`; no submit option, ever.

## Build / run / verify

```bash
pnpm install
pnpm -r build            # tsc -b across packages (respects project refs)
pnpm demo                # full live pipeline, in-memory (the fastest end-to-end check)
pnpm web                 # Next feed at :3000
pnpm -r test             # vitest (add tests in packages/*/src or test/)
```

After editing `core`/`adapters`/`pipeline`, run `pnpm demo` — it hits live free APIs and prints match cards, so it catches integration breaks fast. Note: a re-run after adding a new workspace package needs `pnpm install` to relink symlinks.

## Gotchas

- The in-memory repo doesn't persist across processes; the CLI and web app default to PGlite (`~/.jobflow`, or `JOBFLOW_DATA_DIR` — use a scratch dir while developing). PGlite is single-writer (a lockfile guards the data dir) — use Postgres for concurrent processes.
- The web app never polls inside a request: an empty corpus starts one deduped background sync (`startCorpusSync`); a not-yet-onboarded user gets an unscored browse feed.
- Offline embeddings (`localEmbed`) are a *dev fallback* — semantic discrimination is weak; archetype/stack/location signals carry ranking until a real embedding model is set via `LLM_PROVIDER`.
- LaTeX tailoring rewrites only the document **body**; the preamble is spliced back byte-for-byte (`splitLatexDocument`) and the body must pass `latexBodyIssues` — a cut-off reply throws rather than becoming a draft. PDF compile needs a local engine (tectonic recommended); tectonic's first compile downloads its package bundle and takes minutes.
- Generation drafts are cached by an input hash that includes `PROMPT_VERSION` (`packages/service/src/tailor.ts`) — bump it when you change a generator or prompt so old drafts read as stale.
- `playwright` is an **optional** peer dep of `autofill`; it's imported dynamically and only needed on the local agent (`pnpm add playwright && npx playwright install chromium`).
- The cron GitHub Action persists nothing without a hosted `DATABASE_URL` secret (with `?sslmode=require` — TLS follows `sslmode` only).
- Screenshots: `pnpm screenshots` runs the built web app with `JOBFLOW_DEMO_DATA=1` (offline fictional corpus).
