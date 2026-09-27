# CLAUDE.md — working in the JobFlow codebase

Guidance for Claude Code (and humans) working here. Read the **invariants** first — they're the things that, if violated, break the design's core promises.

## What this is

A full-TypeScript pnpm monorepo: a single-user-first (multi-tenant-ready) job discovery → prep → assisted-apply platform. Three priorities, in order: **job finding**, **honest recommendations**, **autofill up to a review gate**. Architecture rationale is in the spec; operational view is in `README.md`.

## Invariants (do not break these)

1. **Tier boundary is sacred.** The cloud (anything in `apps/worker`, `apps/web` server code, the cron) runs **only Tier 1–2** adapters. Tier 3 (`packages/adapters/src/tier3/`: Naukri, AmbitionBox, Glassdoor, LinkedIn) runs **only on the local agent**. Never register a Tier-3 adapter in `ADAPTERS`/`cloudAdapters()`. Never add a server code path that holds a user's LinkedIn/Naukri/Glassdoor session.
2. **The form-filler never submits.** `packages/autofill` has no code path that clicks submit. `JOBFLOW_AUTOSUBMIT` is hard-`false` in `readFlags()`; `assertNeverSubmits()` throws if it's somehow true. The review screen *is* the value. Don't add a submit step.
3. **Generation is grounded in the candidate's own material.** Every résumé bullet / answer / cover letter rests on the base résumé (`masterResume` / `resumeLatex`), the Evidence Bank, or declared skills — rephrased, reordered, trimmed, never extended. The `HONEST_VOICE` system prompt (`packages/llm/src/prompts.ts`) is mandatory on all generation. No name-dropping unknowns, no tryhard framing. If you add a generation path, pass `HONEST_VOICE`, `candidateBlock()`, and the evidence block. Never pass echo output off as a draft: documents fall back to deterministic builders labelled `builtin`, prose refuses.
4. **Almost nothing is a hard filter.** Stack/seniority/location are *weighted signals with flags*, not gates. The only two hard exclusions live in `hardExclude()` (`packages/core/src/match/score.ts`): salary-below-floor (high-confidence only) and impossible-location (onsite abroad with no sponsorship + relocation off, or a remote role *explicitly* restricted — confidence ≥ 0.85 — to a geo outside the user's `remoteGeoOk`). Don't add hard filters; add a weighted component + an honest flag instead.
5. **Idempotent upserts + freshness.** Postings key on `(atsType, atsJobId)`; non-ATS sources get a source-prefixed id (`scopedJobId`) so feeds can't collide on `unknown`. Re-polling upserts and bumps `lastSeen`; disappeared board postings are soft-deleted via `markStale` (diffed against the FULL board — never a truncated or failed fetch); non-board postings expire via the `FEED_TTL_DAYS` lastSeen sweep in `pollAll`; the between-polls liveness check (`checkLiveness`) retires a posting only on a DEFINITIVE per-job "gone" (404/410 or the board's own closed flag) — never on an error. Freshness scores the source's `postedAt` (the EARLIEST one we've seen — the upsert keeps `least()`, since boards re-stamp reposts), capped by `firstSeen`. Don't introduce duplicate inserts.
6. **One type system.** All shared shapes come from `@jobflow/core` (Zod). Don't redefine `Posting`/`Match`/`Profile` locally; import them.

## Layout & dependency direction

```
core  ←  adapters  ←  pipeline  →  apps
  ↑         ↑           ↑   ↘
  └── db ───┘           │    llm (←core)
                  autofill (←core)
```

- `packages/core` depends on nothing (pure logic + Zod). Put domain logic here; keep it pure and unit-testable.
- `packages/adapters`, `db`, `llm`, `autofill` depend on `core` only.
- `packages/pipeline` orchestrates `core` + `adapters` + `db` (and is handed an `Embedder`/`LlmProvider`).
- `apps/*` compose everything. Seed data + default profile live in `pipeline/src/seed.ts` (shared by cli + worker + web).

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
- **Swap/add an LLM provider:** implement `LlmProvider` in `packages/llm/src/providers/`, wire in `factory.ts`. Keep `embed()` falling back to `localEmbed`.
- **Wire real persistence:** implement `Repository` (`packages/db/src/repository.ts`) as `SupabaseRepository`; migrations are in `packages/db/migrations/`. Then flip `apps/worker/src/repo.ts`.

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

- The in-memory repo doesn't persist across processes — the web feed memoizes one pipeline run per server process (`apps/web/lib/feed.ts`). For durability, wire Supabase.
- Offline embeddings (`localEmbed`) are a *dev fallback* — semantic discrimination is weak; archetype/stack/location signals carry ranking until a real embedding model is set via `LLM_PROVIDER`.
- LaTeX tailoring rewrites only the document **body**; the preamble is spliced back byte-for-byte (`splitLatexDocument`) and the body must pass `latexBodyIssues` — a cut-off reply throws rather than becoming a draft. PDF compile needs a local engine (tectonic recommended); tectonic's first compile downloads its package bundle and takes minutes.
- Generation drafts are cached by an input hash that includes `PROMPT_VERSION` (`apps/web/lib/tailor.ts`) — bump it when you change a generator or prompt so old drafts read as stale.
- `playwright` is an **optional** peer dep of `autofill`; it's imported dynamically and only needed on the local agent (`pnpm add playwright && npx playwright install chromium`).
- Don't `pnpm install` then expect the cron's GitHub Action to persist anything until `SUPABASE_*` secrets are set — without them the worker uses the in-memory repo.
