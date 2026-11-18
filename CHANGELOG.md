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
- **New job sources**: company boards on Recruitee, Personio, Teamtailor, BambooHR and
  Breezy (detected from a careers URL, each with a per-job liveness check), and the Remote OK
  and Jobicy remote boards (links go back to their listings, as their terms require).
- **`canada` discovery preset**: 43 employers hiring in Canada plus Canada-eligible remote
  roles and Canadian aggregators. Onboarding suggests it for a Canadian home country.
- **Remote OK and Jobicy in the presets**: `global-remote.remoteok`, and Jobicy by region in
  `global-remote`, `us`, `eu-uk` and `canada` (new feed ids; `india` is unchanged).
- **Optional `HIMALAYAS_API_KEY`**: Himalayas works without a key, but keyless callers share
  one allowance and busy servers get 429s. A free key gives your account 60/min, 10,000/day.
- **Liveness checks** for Ashby and Himalayas postings (a definitive 404/410 retires a role).

### Changed
- **Bigger, verified presets.** Every non-India seed now carries a board URL checked live
  with at least one role in the preset's markets. Seeds: `us` 47 → 130, `eu-uk` 27 → 133,
  `global-remote` 24 → 31, `india` 230 → 239 (dead and India-less boards dropped, 18
  employers added). See `docs/internal/PRESET_COVERAGE.md`.
- Jobicy is polled at most once an hour per search, enforced by the adapter (its terms).
- Postings from staffing agencies are recognised by more names ("… Consultancy", hiring
  brands) and JD wording ("on behalf of our client", C2C, third-party payroll), and lose
  trust accordingly.
- **Sync polls every board that is due**, most overdue first (daily boards about once a
  day, weekly ones once a week), within a time budget (`JOBFLOW_SYNC_MINUTES`; 5 min, 10 in
  the worker). Before, a fixed 25 boards per sync left a 240-board registry re-polled only
  every 5–10 days. A new install's first sync still stops at 25 boards and the web app
  catches up every quarter-hour. `JOBFLOW_SYNC_MAX_BOARDS` / `jobflow sync --max-boards N`
  cap a run; `--full` now really polls every due board.
- **No single company fills the feed**: at most 3 of its jobs in any 20 cards, the rest
  further down. Scores are unchanged and nothing is hidden. Turn it off with
  `jobflow feed --no-diversify`, the web "score order only" chip, or MCP
  `list_jobs diversify:false`.
- **Salary confidence** is calibrated per market *and* role family, so higher confidence
  again means smaller error (backtest median error by band 39/20/15/10%, was 40/19/21/10%).
- **Match quality**: duplicate detection no longer merges different roles at the same
  company (hidden as duplicates 43–45% → 5–9%); skills match whole words; experience
  requirements ignore employer-age sentences; better title, location (+35 countries) and
  monthly salary parsing; a role's stack note says "direct match" only when you own its
  primary language. See `docs/internal/DISCOVERY_AUDIT.md`.
- **Locations with several places** ("Hybrid - Austin, TX; London, United Kingdom",
  Workday's joined locations) count in every country they name, for preset tags, market
  matching, search place filters and the visa discount. The impossible-location rule fires
  only when none of them is workable.
- **European places in local spellings** (München, Köln, Deutschland, Wien, Zürich, Genève,
  Bruxelles, Warszawa, Praha, Lisboa, København…) are recognised, ignoring accents.
- **Country-only remote**: "Remote - Canada" / "Remote (Brazil)" are a new `country_only`
  remote region, open when the country is your home or a market and down-weighted
  otherwise. New "one country only" filter chip; cards say "Remote · Canada only".
- Every source's postings get the staffing-agency flag at ingest (Naukri's own flag still
  wins); employers mentioning "our clients" or "manpower" are no longer misread as agencies.
- **More locations understood**: comma-separated place lists ("London, Berlin") count every
  country while "City, State" stays one place; European postings name their country
  ("Germany", not "Europe"); HR-system country codes, US state codes, "U.S." and "Home
  based" (remote) are read. Unplaced postings fell from 4.1% to 2.5%.
- Duplicate detection and salary estimates consider every country a posting names; a posting
  that states its pay currency is priced in that country.
- **Stored postings re-parse automatically** once after an upgrade (on the next sync), and
  `jobflow renormalize` runs it by hand.
- Cutshort's "hiring for a client" marks a posting as from a recruiter.
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
- **Feed cards read the same, plainly, everywhere**: one location line built once for the
  web, `jobflow feed`/`show` and the MCP tools — remote roles always say where they can be done
  from ("Remote · worldwide", "Remote · APAC", "Remote · Canada only"), onsite/hybrid roles
  name the real country ("Hybrid · München, Germany", not "München, Europe"), other offices are
  shown ("Onsite · Bengaluru, India + Singapore"; every place on the Job page), and no more
  "Canada, Canada", "Poland, Europe" or "GURGAON". Company names drop legal-form noise
  ("… Pvt. Ltd.", ", Inc.").
- **Fit notes name the right language**: the "main language" now comes from the title or the
  most-mentioned language in the posting, not the first one in the skill dictionary (a
  Go/Python role was "Primary language java"). Notes are plain ("Main language Go — you have
  it. You have Kafka; new to you: Kubernetes.") with no ramp-time guesses or internal ids;
  level notes too ("Senior role; you're mid-level — a common step up"). Must-haves you lack are
  one flag, skipping ones a close language covers. Declared skills the dictionary doesn't know
  ("SQL", "Tableau") count when a posting names them.
- **Ranking a skeptical user would trust**: role-type fit is directional (a frontend
  developer's data, ML and SRE roles no longer score like a backend developer's); data and
  analytics titles count for someone targeting data roles; a req open for months is
  down-weighted (soft, ×0.95–0.85 past 60 days, still flagged); unpaid/volunteer roles and
  freelance marketplaces are flagged; a staffing-agency post always says so on the card
  (badge in the web app and CLI, `agency` in MCP), however many other flags it has.
- **Company spread no longer buries strong jobs**: a company's 4th role at 87 used to land
  below a 42; held-back cards now come back as soon as the next card would score more than 12
  points less, and the company's last card says "+N more at … further down".
- **Job descriptions without markup**: Greenhouse's entity-escaped HTML and numeric entities
  ("C&#43;&#43;", "3&#43; years") are decoded, so the Job page shows text and the parsers see
  C++ and "3+ years". Amazon titles no longer repeat team names; Remote OK titles are decoded.
- **Region-neutral "workable"**: the India-only `indiaWorkable` card field is replaced by
  `workable` (your home country, markets and remote regions); `/api/postings?workable=1`
  (`?india=1` still accepted).
- **Staleness**: a board list cut at a page cap (Amazon, SmartRecruiters, Eightfold, Oracle,
  Jibe, TalentBrew) is marked partial, so a role past the cap is never retired as closed.
- **Eightfold** waits out 429 bursts instead of losing the whole list (Microsoft: 0 → ~200
  India roles per poll).
- **Workday** skips redacted list rows instead of failing the whole board (Mastercard, PwC,
  HPE, Citi: 0 → 160–400 India roles each), and a malformed answer can no longer throw.
- **Greenhouse** reads `offices[]` when a board gives a work mode ("Hybrid") as the
  location: Cloudflare's roles now count in their markets (US 0 → 278, UK/EU 1 → 88).
- **Duplicates**: Workable rows repeated per city fold into one posting with every city;
  Hirist and Qualcomm (Eightfold) no longer return the same job twice in one fetch.
- **HN "Who is hiring"**: job seekers' self-posts are no longer ingested as jobs.
- **Web**: the onboarding wizard and the Search preset chips list every preset (they showed
  only the original four), and a Canadian home country no longer defaults to `us`.
- Re-polling a posting refreshes its duplicate key; a duplicate pointer can be cleared.
- Worker one-shot commands (`salary`, `salary-backtest`, …) exit when done instead of
  hanging.
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
