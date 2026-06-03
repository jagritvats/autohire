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
- 🟡 Application CRM (schema exists; status pipeline / reminders / analytics UI not built).
- ⬜ Calendar wiring for `next_action_at`.

### Local agent (Tier 3, §7.1) — 🟡 scaffolded
- ✅ Tier-3 adapter contract + flag-guard (Naukri/AmbitionBox/Glassdoor/LinkedIn), excluded from cloud registry by design.
- ✅ MV3 extension: manifest, content script (capture + inline match panel), service worker, popup.
- ⬜ Actual local Playwright page-scraping for Tier-3 sources (the `localFetch` impl).
- ⬜ Local cron scheduler + sync-up to Supabase.
- ⬜ Extension ↔ app endpoints (`/api/score`, `/api/capture`) on the web side.

### Trends & digest (§10) — ⬜
- `trend_snapshot` table exists. Skill-trend tracker, gap radar, comp drift, daily/weekly digest not built.

### Enrichment (§11.4–5) — 🟡
- ✅ Salary cascade step 1 (direct-from-JD) + confidence tagging + `salary_cache` table.
- ⬜ Adzuna + levels.fyi `.md` cascade steps; ratings/culture/interview-difficulty summaries (Tier-3 enrichers stubbed).

### Platform / infra — 🟡
- ✅ Multi-tenant schema + RLS + pgvector migrations (`packages/db/migrations`).
- ✅ Repository abstraction + in-memory impl.
- ✅ Swappable LLM (echo/anthropic/grok/openai) + provider embedder.
- ✅ Worker orchestrator (discover|poll|rank) + GitHub Actions cron.
- ⬜ **SupabaseRepository** (the one piece blocking durable persistence; schema + interface are ready).
- ⬜ pg-boss/pgmq queue (currently synchronous in-process).
- ⬜ Tests (vitest configured; suites not yet written — start with `normalize` + `match`).
- ⬜ Tenant settings UI + local-agent auth handshake (multi-tenant hardening, post-v1).

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
