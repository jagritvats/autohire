# JobFlow

**An all-in-one job discovery, prep, and assisted-application platform — built for one user, designed so the ingestion pipeline doubles as a portfolio-grade systems artifact.**

Full TypeScript, end to end. Runs free on infra you already have. The three things it optimizes for: **good job finding**, **honest recommendations**, and **autofill up to a human review gate (never auto-submit)**.

> Full design rationale lives in the architecture spec. This README is the operational view: what's built, how it's shaped, and how to run it.

---

## The aim

A platform like this lives or dies on the **data layer**. The bet:

1. **ATS APIs are the spine.** Greenhouse / Lever / Ashby / Workable expose free, no-auth JSON with full JD text — clean and ghost-free. Aggregators (Remotive, Arbeitnow, RemoteOK, Adzuna) + HN "Who is Hiring" surface *company names*; the **ATS Detector** resolves each to a board slug, and we poll the rich source directly.
2. **Four execution tiers, one routing rule.** The **cloud only ever touches Tier 1–2** (free, legal, low-risk). Everything scrape-hostile (Naukri / Glassdoor / AmbitionBox / LinkedIn = Tier 3) runs **only on the local agent** — your own logged-in session, your IP, human-paced, flag-guarded **off by default**. Tier 4 (paid actors) is optional, never required.
3. **Almost nothing is a hard filter.** Stack, seniority, and location are *soft-weighted scoring signals with honest flags* — a Java dev sees Go/Kotlin/Scala roles because the distributed-systems core transfers. Only **two** genuine hard exclusions: salary below your floor (high-confidence only), and a truly impossible location.
4. **Evidence-grounded generation.** Every tailored bullet / answer cites a real entry in your **Evidence Bank**. If it's not in the bank, it doesn't get said — the direct fix for "tryhard / name-dropping things you don't know."
5. **The match card is the product.** Not the ranked list — the honest card: *why it fits, the likely gap, probable comp, real red flags.* That's what makes you apply well or correctly skip.

---

## What's built (and proven against live APIs)

Running `pnpm demo` exercises the whole spine end-to-end with **zero infra and zero API keys** (in-memory store, offline embeddings, echo LLM):

```
discover → resolve ATS boards → poll Greenhouse/Lever/Ashby → normalize →
dedup → soft-weighted score + rule check → match cards →
LLM re-rank narrative → evidence-grounded tailoring → autofill DRY RUN
```

A representative run: **~560 postings fetched → ~340 deduped → ~270 ranked, ~65 hard-excluded**, with honest cards like:

```
Edge Infrastructure Engineer · Palantir · Hybrid · Warsaw          Match 74
  Stack: scala, postgres, cassandra, distributed_systems, kubernetes
  Fit:   Primary language scala (transferable, ~1-2wk ramp); your
         distributed_systems + postgres depth covers the hard part
  Comp:  est. ₹20L–₹40L (high · jd_direct)
```

The **web feed** renders the same data as a dense, scannable terminal-style UI (see `apps/web`).

---

## Repo shape (pnpm monorepo, full TS)

```
packages/
  core/        Zod schemas + the brain — normalize, dedup, match (pure, testable)
  adapters/    one SourceAdapter per source, tagged by tier; ATS Detector; Tier-3 (local-only)
  db/          Repository interface + in-memory impl + Supabase migrations (RLS, pgvector)
  llm/         swappable provider (echo|anthropic|grok|openai) + re-rank + grounded generation
  pipeline/    orchestration: ingest, dedup, rank, discover, seed data
  autofill/    flag-guarded Playwright form-filler with a review gate (never submits)
apps/
  cli/         `pnpm demo` — the whole pipeline on live APIs, in-memory
  worker/      cloud cron entrypoint (Tier 1-2 ONLY) — discover | poll | rank
  web/         Next.js feed UI (the match-card surface)
  extension/   MV3 capture + inline match panel (read-only, local)
.github/workflows/poll.yml   free GitHub Actions cron (every 6h)
```

The whole thing speaks **one set of types** (`@jobflow/core`), enforced from the ATS adapter through the worker, the API, the UI, the extension, and the Playwright runner.

---

## Quick start

```bash
# Node 20+ and pnpm 9 (corepack enable && corepack prepare pnpm@9 --activate)
pnpm install
pnpm -r build

# 1. See the whole pipeline run against live free APIs (no keys, ~20s):
pnpm demo

# 2. The web feed (live poll on first load, memoized 30m):
pnpm web            # → http://localhost:3000

# 3. The cloud worker (what the cron runs — Tier 1-2 only):
pnpm --filter @jobflow/worker start          # discover + poll + rank
```

**Turning on real LLM output** (re-rank narratives, grounded answers): set `LLM_PROVIDER=anthropic` (or `grok`/`openai`) + the matching key in `.env`. Default is `echo` (offline stub) so everything runs without a key.

**Local agent (Tier 3 + form-fill)** is off by default. See `.env.example` — `JOBFLOW_BROWSER`, `JOBFLOW_BROWSER_MODE`, `JOBFLOW_TIER3_SOURCES`. Autosubmit is hard-coded false (§7.1).

---

## The safety boundary (read before enabling the local agent)

The cloud is permanently confined to Tier 1–2. Tier 3 (Naukri/Glassdoor/AmbitionBox/LinkedIn) and form-fill run **only locally**, through **your own session**, at **human pace**, and **never submit** — the review screen is the value. Layered gates: master flag → mode flag → per-action review → autosubmit (separate, off, locked). This is *you, automated* — not a bot farm. It's still your call and your risk, which is exactly why it's flag-guarded off and isolated behind clean interfaces you can rip out without touching the rest.

---

## Status & roadmap

See **[docs/STATUS.md](docs/STATUS.md)** for what's done, what's stubbed, and what's next, mapped to the spec's phased roadmap.
For working in the codebase, see **[CLAUDE.md](CLAUDE.md)**.

Cost floor: **~$0 + LLM tokens.**
