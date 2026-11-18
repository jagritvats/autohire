# Architecture

JobFlow is a TypeScript monorepo built around three priorities, in order: **finding jobs**,
**honest recommendations**, and **assisted applying up to a human review gate**.

## The bet: the data layer

A job platform lives or dies on its postings. JobFlow reads the cleanest sources first:

1. **ATS APIs are the spine.** Greenhouse, Lever, Ashby, Workable and SmartRecruiters expose
   free, no-auth JSON with full job descriptions; big employers' Workday / Eightfold / Oracle /
   Amazon / Jobvite backends and regional ATSes (Kula, Keka, Zoho Recruit, Freshteam…) are
   polled per market.
2. **Aggregators and community channels add breadth and company names.** Boards, RSS/JSON
   feeds, HN "Who is hiring", Telegram channels. The **ATS detector** (URL → careers-page
   sniff → slug probe) resolves company names to boards, and the posting is then read from the
   board itself.
3. **Logged-in sites stay on your machine.** LinkedIn, Naukri, Glassdoor and AmbitionBox are
   Tier 3: only the local agent touches them, in your own browser session, human-paced, off
   by default.

## Two planes, one database

```
            ┌──────────────── your database (Postgres / PGlite / memory) ───────────────┐
            │  shared: companies, postings        per user: profile, evidence, config,   │
            │                                     matches, drafts, applications, searches│
            └───────────────▲──────────────────────────────────────────▲───────────────┘
                            │                                          │
   CLOUD-SAFE PLANE (Tier 1–2)                          LOCAL PLANE (your machine)
   CLI · web app · worker                               local agent · browser extension
   discover → poll → normalize → dedup → rank           Tier-3 sources in YOUR session
   search · tailor · track                              form-fill → STOP at review
```

The planes talk only through the database (a job queue with a `runtime` per job type). The
cloud-safe plane never holds a session for a logged-in site; the local plane never submits.

## Pipeline

```
discover (presets + your sources + saved searches)
  → resolve boards (ATS detector)
  → poll (concurrent, per host politeness, per market)
  → normalize (title → archetype + level, skills, location + remote geo, salary, experience)
  → dedup (canonical key, then embedding similarity; ATS source wins)
  → idempotent upsert (lastSeen, earliest postedAt, liveness)
  → rank per user (soft-weighted score + two hard exclusions)
  → match cards (why it fits, the gap, stack distance, comp, red flags)
```

### Matching

The score is a weighted sum of components in `[0, 1]`: semantic similarity, stack adjacency
(a Java developer sees Go/Kotlin/Scala roles with an honest ramp note), archetype, seniority
and experience gap, location (home country, markets, remote regions), freshness, salary and
source trust. Only two things are hard exclusions (`hardExclude()`): a **confidently stated**
salary below your floor, and an **impossible location** (onsite abroad with no sponsorship and
relocation off, or a remote role explicitly restricted to a region you can't work from).
Everything else is a weighted signal with a flag.

Views (saved-search filters) are separate from ranking: they hide only on known values, never
change a score, and always report what they hid.

### Generation

Tailored résumés, answers and cover letters are generated only from your base résumé, Evidence
Bank and declared skills, under one system prompt (`HONEST_VOICE`). LaTeX tailoring rewrites
only the document body and splices your preamble back byte-for-byte; truncated output is
rejected, never saved as a draft. Without a model, documents fall back to deterministic
builders labelled `builtin` and prose refuses.

## Packages

| Package | Role |
|---|---|
| `@jobflow/core` | Zod schemas (the one type system) + pure logic: normalize, dedup, match, salary, résumé parsing, views |
| `@jobflow/adapters` | one `SourceAdapter` per source, tier-tagged; search targets; ATS detector; SSRF-guarded fetch; Tier-3 adapters (local only) |
| `@jobflow/db` | `Repository` interface; in-memory, Postgres and PGlite implementations; migrations with RLS; file store; crypto |
| `@jobflow/llm` | providers (Anthropic, OpenAI, xAI, echo), grounded generation, re-rank, résumé extraction |
| `@jobflow/pipeline` | ingest, discover, poll, presets, discovery plan, searches, profile import, salary estimates |
| `@jobflow/resume-io` | file bytes → résumé text (PDF, DOCX, LinkedIn export) |
| `@jobflow/service` | application services shared by the CLI, web app and worker: feed, search, discovery, onboarding, tailoring, apply plan |
| `@jobflow/autofill` | Playwright form-filler with a review gate (never submits) |
| `@jobflow/mcp` | the MCP server for AI agents (`jobflow mcp`): tools, prompts and resources over `@jobflow/service`; opens the store per call and releases it when idle; no form filling |
| `apps/cli` | the `jobflow` command |
| `apps/web` | Next.js UI and API |
| `apps/worker` | scheduled discover → poll → rank (Tier 1–2 only) |
| `apps/agent` | local agent (Tier 3 + form fill) |
| `apps/extension` | MV3 extension: match panel + capture (read-only) |

Design notes and the historical roadmap are in [docs/internal](internal/). Code comments cite
sections of the original design spec as `(§N)`; [internal/VISION.md](internal/VISION.md) and
[internal/IMPLEMENTATION_PLAN.md](internal/IMPLEMENTATION_PLAN.md) carry the rationale.
