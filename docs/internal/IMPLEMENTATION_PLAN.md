# JobFlow — Implementation Plan: web control plane

How we get from **today** (CLI/cron pipeline + a read-only memoized feed) to the **vision** ([VISION.md](VISION.md)): a durable, fully-configurable web control plane that also commands a local agent for Tier-3 browsing and form-fill.

---

## Gap analysis

| Capability | Today | Target |
|---|---|---|
| Storage | in-memory, per-process | Supabase (durable, RLS, pgvector) |
| Profile / prefs | hardcoded in `seed.ts` | edited in a `/settings` UI, drives re-rank |
| Registry | seed list, CLI-discovered | add/curate/poll-now from `/companies` UI |
| Triggering work | `pnpm` commands | buttons → job queue → status streamed back |
| Company ratings | none in cloud feed | on the card + company detail (via enrichment) |
| LinkedIn/Naukri browse | not wired | web button → job → **local agent** runs it |
| Form-fill | CLI dry-run | web "fill" → local agent → review gate |
| Applications | none | CRM with don't-double-apply + reminders |

**The unlock is persistence.** Almost everything below assumes a durable store and a job model. So those are Phase 1–2 and everything compounds on them.

---

## Foundational decisions (recommended)

1. **Persistence: Supabase Postgres** (the schema + RLS + pgvector migrations already exist in `packages/db/migrations`). Works equally against a local/VPS Postgres via `DATABASE_URL` — Supabase just adds auth + Realtime + storage for free. **Implement `SupabaseRepository` behind the existing `Repository` interface; no caller changes.**
2. **Job/command model: a `job` table + Supabase Realtime** (not a heavyweight queue). Web enqueues; the cloud worker drains `runtime=cloud` jobs, the local agent drains `runtime=local` jobs; the UI subscribes to status. Free, durable, and crosses the cloud↔local boundary cleanly. (pg-boss can replace the polling later without API changes.)
3. **Auth: single-user now, multi-tenant-shaped.** One Supabase auth user → one `tenant`. The local agent authenticates with a scoped device token. RLS is already in the schema, so multi-tenant is a later config step, not a rewrite.
4. **Local agent transport: pull, not push.** The agent long-polls/subscribes for its jobs and writes results back. The web never opens a connection *into* your machine, and never holds a session — it just leaves jobs in the DB. This is what keeps "browse LinkedIn from the web" on the right side of invariant #1.

---

## New data model (additive to `packages/db/migrations`)

```sql
-- 0003_jobs.sql
create table job (
  id           uuid primary key default uuid_generate_v4(),
  tenant_id    uuid not null references tenant(id) on delete cascade,
  type         text not null,           -- poll | rank | enrich_t1 | tier3_poll | enrich_t3 | form_fill | discover
  runtime      text not null,           -- 'cloud' (tier1-2) | 'local' (tier3 + fill)
  payload      jsonb not null default '{}',
  status       text not null default 'queued',  -- queued|running|done|error|canceled
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  picked_at    timestamptz,
  finished_at  timestamptz
);
create index job_drain_idx on job (runtime, status, created_at);

create table agent_heartbeat (
  tenant_id    uuid primary key references tenant(id) on delete cascade,
  last_seen    timestamptz not null default now(),
  version      text,
  flags        jsonb not null default '{}',     -- the agent's live automation flags
  enabled_sources text[] not null default '{}'
);
```

RLS: both tenant-scoped (same policy pattern as `0002_rls.sql`). The cloud worker + local agent run as service role to drain across the tenant.

---

## Phase 1 — Persistence & configuration foundation

*Goal: the feed reads durable data, and you can edit your profile/prefs in the UI and watch the feed re-rank.*

**Tasks**
- `packages/db/src/supabase.ts` — `SupabaseRepository implements Repository`. Map every method to SQL (postings upsert on `(ats_type, ats_job_id)`, pgvector for embeddings/match, `markStale`, matches, profile, evidence). Add `@supabase/supabase-js`.
- `apps/web/lib/repo.ts` — compose `SupabaseRepository` when env present, else `InMemoryRepository` (mirrors `apps/worker/src/repo.ts`; share via a tiny `@jobflow/db` factory).
- Replace `apps/web/lib/feed.ts` memoized in-process poll with **reads from the repo** (`listMatches` + stats). Ingestion moves to the worker/queue (Phase 2), not the page load.
- `apps/web/app/settings/page.tsx` + `components/SettingsForm.tsx` (client): edit
  - **tech stack** (multi-select of canonical skills + free-add),
  - **expected comp** (floor + currency),
  - **location weights** (ranked list editor),
  - **target archetypes**, **remote-geo tolerance**,
  - **source toggles** + **poll cadence**,
  - **automation flags** (browser on/off, Tier-3 opt-ins) with the safety copy.
- `apps/web/app/api/profile/route.ts` + `api/config/route.ts` — GET/PUT to repo; a PUT enqueues a `rank` job (Phase 2) or re-ranks inline for now.
- `packages/db/src/migrate.ts` — runnable migrator (`pnpm db:migrate`).

**Acceptance:** edit stack from `₹20L`→`₹30L` floor or add `rust`; the feed reflects new ranking after refresh. Data survives a server restart.

---

## Phase 2 — Command plane (jobs, status, registry)

*Goal: trigger ingestion/ranking/enrichment from buttons; manage the company registry from the UI; see live status.*

**Tasks**
- `0003_jobs.sql` + `Repository` job methods (`enqueueJob`, `claimJob`, `completeJob`, `listJobs`).
- `apps/worker` → a **job runner loop**: drain `runtime=cloud` jobs (`poll`, `discover`, `rank`, `enrich_t1`), update status. Keep the existing `discover|poll|rank` as the job handlers. Runs on cron *and* on-demand.
- `apps/web/app/api/jobs/route.ts` — POST to enqueue, GET to list; Realtime subscription in the UI for status.
- UI: a **command bar / activity panel** — "Re-poll now," "Re-rank," "Enrich top N," with inline progress (from Realtime).
- `apps/web/app/companies/page.tsx` — registry table: add by name/URL (calls a `discover` job → detector resolves), tag, set cadence, pause/remove, "poll now" (enqueues a per-company `poll` job).

**Acceptance:** add "Razorpay" in the UI → detector resolves its board → "poll now" ingests its postings → they appear in the feed, all without a terminal.

---

## Phase 3 — Company intelligence + CRM

*Goal: ratings/comp on cards, a company view, and an application pipeline.*

**Tasks**
- **Tier-1 enrichment cascade** (`enrich_t1` job): Adzuna (salary, free) + levels.fyi `.md` (attributed) → fill `posting.salary_est_*` + `company.rating_*` where reachable server-side. Gate on match score. Cache via `salary_cache`.
- Surface enrichment: comp + confidence already on the card; add **company ratings** + a `apps/web/app/company/[id]/page.tsx` detail view (postings, ratings, culture summary, interview difficulty).
- **CRM**: `apps/web/app/applications/page.tsx` — status pipeline (saved→applied→…→outcome), `next_action_at` reminders, **don't-double-apply** guard surfaced inline on cards (uses `appliedDedupKeys`).
- Conversion analytics → a small signal fed back into ranking weights.

**Acceptance:** a top match shows an Adzuna/levels comp range with confidence; applying to it marks it in the CRM and warns on any re-apply.

---

## Phase 4 — Local agent companion (the "browse from web" unlock)

*Goal: from the web, start LinkedIn/Naukri browsing and form-fills that run on your machine, in your session, to a review gate.*

**Tasks**
- `apps/agent/` — a long-running local Node process (PM2 on Aurelius):
  - authenticates (device token), writes `agent_heartbeat` every ~30s with its live flags + enabled sources,
  - drains `runtime=local` jobs: `tier3_poll` (Naukri/AmbitionBox/Glassdoor/LinkedIn), `enrich_t3` (ratings/India comp), `form_fill`,
  - executes via Playwright `launchPersistentContext` on **your** profile, human-paced, honoring `readFlags()` + the per-action gates,
  - implements the `Tier3Context.localFetch` the `packages/adapters/src/tier3` adapters expect; writes postings/enrichment/application updates back through the repo.
- Wire the **review gate**: `form_fill` opens the form, fills from profile + tailored answers, **stops** (never submits); the agent reports "awaiting review," the web shows it.
- UI: **agent status panel** (online/offline from heartbeat, enabled sources, flags) + dispatch buttons — "Start LinkedIn browse," "Enrich (Tier-3)," "Fill this application." Buttons are disabled with a clear message when the agent is offline or the source isn't opted in.
- Flags UX: the settings automation section flips `tenant_config.automation_flags`; the agent reads them; the hard gates (`JOBFLOW_AUTOSUBMIT=false`, master `JOBFLOW_BROWSER`) stay env-level on the agent so the web can never force a submit.

**Acceptance:** with the agent running and `linkedin` opted in, clicking "Start LinkedIn browse" enqueues a local job; the agent pulls jobs from your session, syncs results to the feed, and a "fill" lands you on a pre-filled review screen you submit by hand.

---

## Phase 5 — Prep agents, trends, digest

- Prep multi-agent graph (Researcher / Question Forecaster / Prep-Plan / Evidence Matcher) + `question_bank` accretion — surfaced as a "Prep" tab per match.
- Trends layer (skill-trend, gap radar, comp drift) — aggregate queries on the corpus.
- Daily/weekly digest (email/push) — new high-match roles, due reminders, trend deltas.

---

## Cross-cutting

- **Auth & security.** Supabase auth for the web user; a scoped device token for the agent. RLS enforces isolation. Automation flags are surfaced read-only in the extension popup and editable (soft flags only) in settings; hard gates remain env-level on the agent.
- **Safety copy in the UI.** Every Tier-3 / form-fill control carries the §7.1 honest-risk note. Autosubmit is shown as "false · locked."
- **Testing.** Start vitest suites now for the pure cores (`normalize`, `match`, `dedup`) — they're the quality-critical units and don't need infra. Add repo contract tests (run the same suite against in-memory + Supabase).
- **Cost.** Still ~$0 + LLM tokens: Supabase free tier, GitHub Actions cron, Vercel/VPS free, local agent on hardware you own.
- **Invariants preserved.** Cloud job runner only ever handles `runtime=cloud` (Tier 1–2). Tier-3 adapters stay out of `ADAPTERS`/`cloudAdapters()`. No web/server path holds a scrape-hostile session.

---

## Sequencing & rough effort

| Phase | Outcome | Effort |
|---|---|---|
| 1 | Durable + configurable from web (the core ask) | ~1 weekend |
| 2 | Trigger + curate from web; live status | ~1 weekend |
| 3 | Ratings/comp + CRM | 2–3 evenings |
| 4 | Local agent: browse + fill from web | ~1 weekend |
| 5 | Prep + trends + digest | incremental |

**Phases 1–2 deliver the heart of this request** (configure + manage everything from the web). Phase 4 delivers "start LinkedIn browsing from the web," safely. Each phase is independently shippable.

---

## Immediate next actions (Phase 1 kickoff)

1. Add `0003_jobs.sql` + a runnable `migrate` script.
2. Implement `SupabaseRepository` + the shared repo factory; point web + worker at it.
3. Build `/settings` (profile + prefs + flags) with GET/PUT APIs; a save re-ranks.
4. Switch the feed from in-process poll to repo reads.
5. First vitest suite on `normalize` + `match` to lock quality while we refactor.
