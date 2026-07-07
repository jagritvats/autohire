# JobFlow — build status & remaining work

Snapshot of what exists in this repo today, mapped to the spec's phased roadmap (§8). Legend: ✅ done & verified · 🟡 scaffolded/partial · ⬜ not started.

---

## Verified end-to-end

`pnpm demo` runs the full spine on **live free APIs** with zero infra/keys and prints honest match cards. `pnpm web` renders the same data as a feed UI (verified: 80 cards, score badges, stats, apply links rendering from a live poll). `pnpm -r build` is green across all packages.

The four ATS/discovery sources were probed live and return real data: **Greenhouse, Lever, Ashby, HN Algolia** (Workable adapter written, degrades safely).

---

## By component

### Finding (Pillar 1) — ✅ core done
- ✅ `SourceAdapter` interface, tier-tagged; orchestrator routes by tier.
- ✅ ATS pollers: Greenhouse, Lever, Ashby, Workable (`packages/adapters/src/ats/`).
- ✅ Aggregators: Remotive, Arbeitnow + HN "Who is Hiring" harvester.
- ✅ **ATS Detector** — URL-pattern + live-probe slug resolution (the linchpin); resolves company *names* → boards.
- ✅ Company Registry (in-memory repo) with poll cadence + `dueForPoll`.
- ✅ Normalizer — title→canonical + level band, skill extraction (alias dictionary, ambiguity-guarded `go`/`rest`), requirement strength, location/geo parsing, direct salary extraction.
- ✅ Deduper — stage-1 canonical key + stage-2 embedding-cosine merge; ATS source wins as canonical.
- ✅ Idempotent upsert + soft-delete-on-disappear (freshness).
- 🟡 RemoteOK, Adzuna, Jobicy, levels.fyi, YC, LinkedIn-guest adapters — interface ready, not yet written.

### Recommendations (matching intelligence, §11) — ✅ core done
- ✅ Soft-weighted scorer: semantic + stack-adjacency + **archetype** + seniority + location + freshness + salary, with score breakdown.
- ✅ Stack adjacency matrix (Java→Go/Kotlin/Scala/Node…) + systems-core bonus + honest language-ramp note.
- ✅ Geo-restriction detection (`us_only`/`eu_only` "remote" down-weighted hard + flagged).
- ✅ The only two hard exclusions (salary floor, impossible location).
- ✅ LLM re-ranker → `{whyFit, gap, redFlags, scoreAdjust}` (honest-voice, evidence-aware).
- ✅ Match card render (CLI + web).
- 🟡 Re-rank currently enriches but is not yet persisted back onto `match` rows in the loop (function exists; wire into `rebuildMatches`/worker).

### Enrichment + CRM (control-plane Phase 3) — ✅ done & verified on local Supabase
- ✅ **Tier-1 comp cascade** (§11.4): `levels.fyi` `.md` enricher (free, no key, **attribution surfaced**) — parses all-roles median + per-job-family table; `Adzuna` enricher (country-aware incl. India, key-gated). Cascade `direct → adzuna → levels`, **gated on match score** (top-N only), cached in `salary_cache` (TTL), with **honest confidence** (US levels comp → `low` for non-US roles).
- ✅ Verified live: 9 companies got comp benchmarks (Stripe $285k median…), 21 postings estimated.
- ✅ **Company detail page** (`/company/[id]`): comp median + job-family breakdown + levels.fyi attribution; ratings panel (honest "Tier-3 / local agent" placeholder); open postings.
- ✅ Comp surfaced on cards, **estimates marked** (`~ … est`) so a modeled number is never shown as fact.
- ✅ **`enrich_t1` job** (worker handler + `enrich` one-shot + "Enrich comp" command-bar button).
- ✅ **Application CRM** (`/applications`): track from a card (`+ track`), status pipeline (saved→…→outcome) with a funnel, next-action + due-date reminders, **don't-double-apply badge** (`✓ in CRM`) on the feed.

### Prep (Pillar 2, §4) — 🟡 generation done, agents pending
- ✅ Evidence Bank (schema + seed: NexusAlgo / kafka-ui / Verdict / ZFH ledger / Synapse).
- ✅ Resume tailoring (3 strategy variants + ATS keyword coverage) — evidence-grounded.
- ✅ Application-answer generation — honest-voice, evidence-cited.
- ⬜ Multi-agent prep graph (Researcher / Question Forecaster / Prep-Plan / Evidence Matcher).
- ⬜ `question_bank` accretion across applications.

### Apply (Pillar 3, §7) — 🟡 autofill done, CRM pending
- ✅ Flag-guarded autofill: `readFlags`, layered gates, human pacing.
- ✅ Per-ATS field maps (Greenhouse/Lever/Ashby/Workable/Workday) + fill-plan builder + dry-run.
- ✅ Playwright runner that fills to a **review gate and never submits** (lazy-imported).
- ✅ Don't-double-apply guard (`alreadyApplied` + `appliedDedupKeys`).
- ✅ Application CRM (`/applications`): status pipeline + funnel + next-action reminders + don't-double-apply (Phase 3).
- ⬜ Calendar wiring for `next_action_at` (reminders surface in-app today).

### Local agent (control-plane Phase 4, §7.1) — ✅ runtime done & verified; per-site parsing to tune
- ✅ **`apps/agent`** runtime: connects to the shared DB, **heartbeats** every 30s (UI shows it online + flags/sources), **drains `runtime=local` jobs** sequentially in the user's own browser context (lazy Playwright — boots without Chromium installed).
- ✅ **Effective-flags merge**: env machine-gate (`JOBFLOW_BROWSER`/`MODE`) ∧ web toggle, source opt-ins, `autosubmit` hard-false. Verified: with browser off, the agent claims local jobs and **refuses** them with a clear message; the cloud worker never sees them (`runtime` boundary).
- ✅ **form_fill** handler → `fillPlanOnPage` (autofill) opens the form in the user's session, fills from the profile Contact + answers, **stops at the review gate** (no submit path); marks the CRM row "review & submit".
- ✅ **tier3_poll / enrich_t3** framework: flag-guarded, `localFetch` (user-session page fetch) wired into the Tier-3 adapters; normalize→upsert reuses the pipeline.
- ✅ Web dispatch: local jobs enqueue-able (guarded); **"fill"** on CRM rows, **"browse {source}"** in Settings; **Contact** settings section for the filler.
- ✅ MV3 extension: manifest, content script (capture + inline match panel), service worker, popup.
- ⬜ Per-site Tier-3 selectors (Naukri/LinkedIn/Glassdoor/AmbitionBox) — best-effort; tune on your session/locale (see docs/SETUP.md).
- ⬜ Extension ↔ app endpoints (`/api/score`, `/api/capture`); local cron for unattended Tier-3 sync.

### Bug fixes (this round)
- ✅ `/api/jobs` infinite re-render (ActivityPanel effect depended on the state it set) → stable mount-once self-scheduling poller.
- ✅ Sidebar nav overflow with 4 tabs + mode pill → wraps cleanly.
- ✅ Settings page crash in durable mode → the SQL-seeded `automation_flags` used snake_case (`tier3_sources`) but the app reads camelCase; `getConfig` now normalizes both, migration default fixed, form hardened.

### Trends & digest (§10) — ⬜
- `trend_snapshot` table exists. Skill-trend tracker, gap radar, comp drift, daily/weekly digest not built.

### Enrichment (§11.4–5) — ✅ Tier-1 done; ratings are Tier-3 (Phase 4)
- ✅ Salary cascade: direct-from-JD → Adzuna (key-gated) → levels.fyi `.md` (free, attributed), cached + confidence-tagged, gated on match score.
- ⬜ Ratings/culture/interview-difficulty summaries — Tier-3 (AmbitionBox/Glassdoor) via the local agent (Phase 4); the UI panel + data model are ready.

### Platform / infra — ✅ control-plane Phase 1 done
- ✅ Multi-tenant schema + RLS migrations (`packages/db/migrations`); embeddings stored as `jsonb` (pgvector is the documented scale path).
- ✅ Repository abstraction + in-memory impl **+ `PgRepository`** (node-postgres) — durable persistence against Supabase/any Postgres via `DATABASE_URL`.
- ✅ Runnable migrator (`pnpm db:migrate`) + repo factory (`createRepository()` → Postgres if `DATABASE_URL`, else in-memory).
- ✅ `0003_jobs.sql` — `job` + `agent_heartbeat` tables (command-plane foundation for Phase 2/4).
- ✅ **Settings UI** (`/settings`): edit stack, comp/floor, YoE/level, target archetypes, remote-geo, location weights, automation flags + Tier-3 opt-ins. `PUT /api/profile` re-ranks the feed (verified: changing stack reorders results); `GET/PUT /api/config`.
- ✅ Web feed reads from the repo (no more per-process memo hack); `/api/refresh` re-polls + re-ranks through the repo.
- ✅ Swappable LLM (echo/anthropic/grok/openai) + provider embedder.
- ✅ Worker orchestrator (discover|poll|rank) on the shared repo factory + GitHub Actions cron.
- ✅ **Tests** — vitest suites for `normalize` + `match` (24 tests; caught 2 real bugs on the way in).
- ✅ **Local Supabase** wired (Docker, project `jobflow`, ports 553xx) + root-`.env` loader; migrations applied; verified durable (1.2k+ postings persisted).

### Command plane (control-plane Phase 2) — ✅ done & verified on local Supabase
- ✅ `job` queue: `Job` type + Repository methods (`enqueueJob` / `claimJob` with `FOR UPDATE SKIP LOCKED` / `completeJob` / `listJobs`) + `agent_heartbeat`. **`runtime` encodes the tier boundary** — the cloud runner refuses any `local` job.
- ✅ **Worker job-runner** (`pnpm --filter @jobflow/worker runner`): drains `runtime=cloud` jobs (discover/poll/rank/enrich_t1), writes status back.
- ✅ **Web command plane**: `/api/jobs` (enqueue + list), `/api/companies` (list/add-with-detection/poll-now/pause/cadence/remove). **Activity panel** (live job status + agent-online pill + "no worker draining" hint) on the feed + registry.
- ✅ **`/companies` registry UI**: add by name/URL → ATS Detector resolves the board → auto-poll; pause/resume, cadence, remove. (Verified: added "Notion" from the UI → resolved `ashby/notion` → 143 postings ingested.)
- ⬜ Realtime push (currently the panel polls every 1.5–5s) — swap to Supabase Realtime later.
- ⬜ Auth (Supabase) + local-agent device-token handshake (Phase 4 / multi-tenant hardening).

---

## Recommended next steps (highest leverage first)

1. **SupabaseRepository** — unlocks durability, the web feed reading real data, and the cron actually accumulating a corpus. Everything else compounds on this.
2. **Persist re-rank narratives** into `match` rows in `rebuildMatches` (gate LLM calls to top-N for cost).
3. **Web `/api/score` + `/api/capture`** so the extension closes the loop.
4. **Tests** for `normalize` (titles/skills/location/salary) and `match` (stack adjacency, hard exclusions, geo down-weight) — these are the quality-critical, pure, easily-tested units.
5. **Enrichment cascade** (Adzuna + levels.fyi) — cheap, free, improves comp confidence on the feed.
6. **Application CRM UI** + don't-double-apply surfaced in the feed.
7. **Prep multi-agent graph** + question bank.
8. **Local Tier-3 `localFetch`** + cron (only when you choose to opt in).

## Known limitations (today)
- In-memory store → no persistence across processes; web memoizes one poll per server process.
- Offline `localEmbed` → weak semantic discrimination; set a real `LLM_PROVIDER` for better embeddings/narratives.
- Salary currency detection is heuristic; a few USD ranges can mislabel as INR (gated to high-confidence + matching-currency before it ever affects the hard exclusion, so it's safe but visible on cards).
- Adapter coverage is the confirmed-live set; broaden the seed list + add the remaining aggregators for volume.
