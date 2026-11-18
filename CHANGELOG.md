# Changelog

All notable changes to JobFlow are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **MCP server for AI agents**: `jobflow mcp` (new package `@jobflow/mcp`) serves JobFlow
  over the Model Context Protocol on stdio, for Claude Code, Claude Desktop or any MCP client.
  Tools: `jobflow_status`, `search_jobs`, `list_jobs`, `get_job`, saved searches,
  `track_application` / `list_applications`, `prepare_application` (a dry-run apply plan plus
  the `jobflow apply <id> --fill` command; nothing is filled or sent), `draft_document`
  (grounded generators) and `sync_sources`. Prompts: `tailor_application` (the HONEST_VOICE
  rules and your own material, for agents writing with their own model) and `triage_jobs`.
  Resources: `jobflow://profile`, `jobflow://job/{id}`. The local database is opened per call
  and released after 20 s idle, so the CLI and web app keep working. See
  `docs/guides/ai-agents-mcp.md`.

### Changed
- **New design system** ("calm ledger"): neutral Radix-based palette with one action colour
  and fixed semantic colours, Inter type, light/dark/system themes at WCAG AA, a shared
  navigation shell, responsive down to 375px with a filter drawer, and accessibility passes
  (skip link, focus rings, labels, live regions). See `docs/internal/DESIGN.md`.
- **Journeys rebuilt**: navigation is Jobs · Search · Applications · Profile · Sources ·
  Settings; a new **Job page** per role (fit, description, drafts, an apply checklist with a
  fix for each gap, open / pre-fill / mark applied); a get-started checklist; saved-search
  tabs; filters always report what they hid; keyboard shortcuts on Jobs; Profile split from
  Settings. `/searches` and `/discovery` redirect. See `docs/internal/UX_AUDIT.md`.
- **CLI**: `jobflow` with no arguments shows your status and next step; `init --yes`
  refuses an empty profile; `apply` marks a job ready only when nothing is missing; clearer
  help, hints and errors.
- **The web app saves by default**: it shares the CLI's durable store in `~/.jobflow`
  instead of an in-memory fallback, and keeps the feed synced on a schedule while open.

### Fixed
- Finishing onboarding during the first background sync no longer leaves the feed unranked.
- Search before onboarding no longer makes fit claims about an empty profile.

### Docs
- Rewritten CONTRIBUTING.md and new contributor guides in `docs/contributing/`.

## [0.1.0] — 2026-11-18

The first public release: a local-first job search engine with honest match cards, grounded
tailoring and an autofill that always stops at a human review gate.

### Finding jobs
- **ATS-first discovery**: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday,
  Eightfold, Oracle HCM, Amazon, Jobvite, Rippling, Kula, Keka, Zoho Recruit, Freshteam and
  more, polled concurrently with per-host politeness; an ATS detector resolves company names
  and careers URLs to boards.
- **Discovery presets** — India, Global remote, United States, Europe & UK — switch on any
  combination; each preset's feeds can be turned off individually.
- **Your own sources** on top of the presets: companies, CSV company lists, RSS/Atom and JSON
  feeds (with field mapping), Telegram channels, HN "Who is hiring" threads. User-supplied
  URLs are SSRF-guarded.
- **Live search** (`jobflow search`, `/searches`): asks search-capable boards now and scores
  every result against your profile; `--remote`, `--loc`, `--seniority`, `--min-salary`,
  `--posted`, `--must`/`--nice`, `--preset` (preset tags) and more. Filters are views — they
  hide only known values, report what they hid, and never change a score.
- **Saved searches** that run on every sync and can be used as feed views.
- Freshness: idempotent upserts, earliest-seen publish dates, staleness only from complete
  board fetches, per-job liveness checks, feed TTLs.

### Honest recommendations
- Match cards: score, why it fits, stack distance with an honest ramp note, seniority and
  experience gap, stated pay vs. clearly marked estimates, source trust, red flags (e.g. a
  "remote" role that is US-only), preset tags.
- Only two hard exclusions (a confidently stated salary below your floor; an impossible
  location); everything else is a weighted signal. Region-neutral: home country and markets
  drive location scoring.
- Salary estimates with confidence from posted ranges, Adzuna and levels.fyi (attributed).

### Your profile
- **Résumé import** from PDF, DOCX, LaTeX, Markdown, text, JSON Resume and LinkedIn data
  exports. Extraction copies spans from your file; optional model-assisted extraction is
  filtered so nothing absent from the source survives. You review everything before it's
  saved.
- **Evidence Bank** of citeable claims; onboarding in the web app (`/onboarding`) or
  `jobflow init`; a fictional sample persona for trying it out.

### Applying
- **Grounded tailoring**: résumé variants, LaTeX/Markdown rewrites (preamble kept
  byte-for-byte) with PDF compile, cover letters and application answers — only from your
  résumé, evidence and declared skills. Without a model, documents fall back to labelled
  built-in templates and prose refuses.
- **Autofill to a review gate**: `jobflow apply --fill` / the local agent fill Greenhouse,
  Lever, Ashby, Workable and Workday forms (generic map elsewhere), attach your résumé, and
  stop. There is no submit option or code path; a real-browser test asserts zero submissions.
- Application tracker with statuses, next actions and a don't-double-apply guard.

### Interfaces
- **`jobflow` CLI** (local-first, zero setup): init, profile, evidence, config, search,
  searches, discovery, sync, rank, feed, show, tailor, apply, track, doctor, serve, demo.
  Durable storage in `~/.jobflow` (PGlite — Postgres in WASM).
- **Web app**: ranked feed, search, discovery settings, onboarding, tailoring editor with PDF
  preview, pipeline, company pages, settings.
- **Worker** for scheduled discover → poll → rank; **local agent** for logged-in (Tier-3)
  sites on your own machine; **MV3 browser extension** with an inline match panel.
- Optional multi-user hosting mode (`JOBFLOW_AUTH=password`): accounts, sessions, scoped API
  tokens, per-user data and LLM keys (encrypted at rest with `JOBFLOW_SECRET_KEY`).

### LLM providers
- Anthropic, OpenAI, xAI (Grok) or OpenAI-compatible gateways — all optional; offline `echo`
  by default. Keys are write-only in the UI and redacted from errors and logs.

### Project
- Licensed under the **GNU AGPL-3.0-only**; the web app links to its source (§13).
- Docs: getting started, CLI reference, guides, configuration, architecture, legal & ethics.
- CI: build, typecheck, ~650 offline tests, plus personal-data and tenant-isolation guards.

[Unreleased]: https://github.com/jagritvats/autohire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jagritvats/autohire/releases/tag/v0.1.0
