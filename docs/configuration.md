# Configuration reference

Every setting is optional — a fresh clone runs with no keys and no database. Put settings in
the repo-root `.env` (copy `.env.example`) or in `$JOBFLOW_DATA_DIR/.env` (default
`~/.jobflow/.env`). Values already set in your shell win. Per-user settings you'd rather
not keep in a file (your LLM key, preferences, sources) are set with `jobflow config` /
`jobflow profile` or in the web app's Settings, and stored in your own database.

## Storage, accounts and data

| Var | Default | What it does |
|---|---|---|
| `JOBFLOW_DATA_DIR` | `~/.jobflow` | Where your data lives: the local PGlite database, uploaded résumés, tailored PDFs, the agent's browser profile. Never inside the source tree. |
| `JOBFLOW_STORE` | `pglite` for the CLI, `memory` for the web app | `pglite` (durable, zero-setup Postgres-in-WASM under the data dir) · `memory` (nothing persists) · `postgres` (use `DATABASE_URL`). |
| `DATABASE_URL` | _(blank)_ | Your own Postgres. Wins over `JOBFLOW_STORE`. For hosted Postgres append `?sslmode=require`. |
| `JOBFLOW_SAMPLE_PROFILE` | _(off)_ | `1` starts new profiles as the fictional sample candidate instead of blank. |
| `JOBFLOW_DEMO_DATA` | _(off)_ | `1` seeds an offline, fully fictional corpus (screenshots, UI work). |
| `JOBFLOW_AUTH` | `none` | `none`: single-user, answers only on localhost. `password`: accounts for a shared/hosted instance — see [guides/self-hosting.md](guides/self-hosting.md). |
| `JOBFLOW_SECRET_KEY` | _(blank)_ | 32-byte base64 key; when set, stored LLM keys are encrypted at rest. Required for hosting. |
| `JOBFLOW_SIGNUP` | `closed` | Hosted mode: `open` lets anyone create an account (the first account is always allowed and becomes admin). |
| `JOBFLOW_OPERATOR_LLM` | `shared` single-user / `off` hosted | Whether users without their own key may use the operator's `LLM_PROVIDER` key. |
| `JOBFLOW_TRUST_NETWORK` | _(off)_ | `1` lets single-user mode answer on non-localhost hosts (only behind your own authenticating proxy). |
| `JOBFLOW_AGENT_TOKEN` | _(blank)_ | Hosted mode: the local agent's API token (scope `agent`). |

## Environment variables (full reference)

Grouped by what they unlock. Storage and accounts are covered above.

### LLM (re-rank narratives, grounded answers/resume)
| Var | Required? | What it does |
|---|---|---|
| `LLM_PROVIDER` | optional | `echo` (default, offline) · `anthropic` · `grok` · `openai`. You can also set your provider and key per user with `jobflow config set llm.provider …` / Settings. |
| `LLM_MODEL_CHEAP` | optional | cheap model for extraction (default for anthropic: `claude-haiku-5-5`). |
| `LLM_MODEL_STRONG` | optional | strong model for re-rank, tailoring and answers (default for anthropic: `claude-opus-5-5`). |
| `ANTHROPIC_API_KEY` | if provider=anthropic | console.anthropic.com. |
| `XAI_API_KEY` | if provider=grok | console.x.ai. |
| `OPENAI_API_KEY` | if provider=openai | platform.openai.com (also enables real embeddings). |

### Enrichment (Tier 1, free)
| Var | Required? | What it does |
|---|---|---|
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | optional | developer.adzuna.com (free). Unlocks country-aware salary estimates incl. India. **Without these, the cascade falls back to levels.fyi (US).** |
| _(levels.fyi)_ | none | No key — free `.md` endpoint, attribution surfaced automatically. |

### Local agent (Tier 3 + form-fill) — §7.1, all OFF by default
| Var | Default | What it does |
|---|---|---|
| `JOBFLOW_BROWSER` | `off` | **Master kill switch (machine-level hard gate).** Must be `on` for the agent to run any browser action. |
| `JOBFLOW_BROWSER_MODE` | `capture` | `capture` \| `fill`. `fill` is required for the form-filler. |
| `JOBFLOW_AUTOSUBMIT` | `false` | Hard-coded false. Flipping requires a code change + per-app opt-in — by design it stays off. |
| `JOBFLOW_RATE` | `human` | `human` (jittered 0.5–2s) \| `fast`. Keep `human`. |
| `JOBFLOW_TIER3_SOURCES` | _(empty)_ | Optional env allow-list (csv: `naukri,linkedin,peerlist,wellfound,darwinbox,glassdoor,ambitionbox`). If set, restricts which sources the web can enable. |
| `JOBFLOW_BROWSER_PROFILE` | `.jobflow/browser-profile` | Path to the Chromium user-data dir the agent drives — point it at a profile **logged into** LinkedIn/Naukri/etc. |
| `JOBFLOW_LOCAL_POLL_EVERY_HOURS` | `12` | Unattended schedule: when the last run of an opted-in source is older than this, the agent enqueues it itself (`tier3_poll` for naukri/linkedin/peerlist/wellfound, `local_board_poll` for darwinbox), then drains them one at a time, human-paced. Only while the browser gates are on (both `JOBFLOW_BROWSER=on` and the web master switch), so it's off by default. `0` = off (click-to-run only). |

#### Tier-3 poll targeting — the "good-paying software/engineering in India" sweep

All **optional**; unset → curated defaults (`INDIA_SWE_QUERIES` × Indian tech hubs, incl. a remote pass). These shape **what** the local agent browses, not the match filter — the ranker still weights salary/location/stack with honest flags (invariant #4). `minLpa` defaults to your **profile's INR salary floor** expressed in LPA.

| Var | Example | What it does |
|---|---|---|
| `JOBFLOW_TIER3_QUERIES` | `backend engineer,platform engineer,sde` | csv keyword-query override (else the curated software/eng set). |
| `JOBFLOW_TIER3_LOCATIONS` | `bengaluru,pune,hyderabad` | csv Indian hub override (blank hubs still includes a remote/location-agnostic pass). |
| `JOBFLOW_TIER3_MIN_LPA` | `20` | soft CTC floor in LPA (lakhs/annum); biases the search toward well-paid roles. |
| `JOBFLOW_TIER3_FRESHNESS_DAYS` | `15` | recency window for the search facet. |
| `JOBFLOW_TIER3_LIMIT` | `25` | cards pulled per (query × location) cell. |
| `JOBFLOW_TIER3_MAX_TARGETS` | `8` | politeness cap on total cells per browse (sequential, human-paced). |

Peerlist and Wellfound have no city/CTC facets, so they ignore the hub/CTC knobs: the query list is mapped onto each site's role families (e.g. `java developer` → `backend-engineer`), deduped, and at most 3 role listings are read per run (Peerlist: 1 page of 50 newest; Wellfound: 2 pages of `/role/l/{role}/india`). Override per run with the job payload (`queries`, `maxTargets`, `maxPages`, `limit`, `location` for Wellfound).

#### Local-only sources (bot-walled from servers)

Some sources sit behind Cloudflare, which turns away anything but a real browser, so the cloud can't read them. They run **only** on the agent, in your browser (invariant #1). None needs a login.

| Source | Opt-in name | Job | What it reads |
|---|---|---|---|
| **Darwinbox** careers boards (Porter, Upstox, Seclore, Rapido) | `darwinbox` | `local_board_poll` | A board ATS. Every active registered company with `atsType=darwinbox` is polled through the same `ingestCompany` the cloud uses: idempotent upserts, and staleness is diffed against the **full** board (a failed or partial fetch returns nothing, so nothing is marked stale). The detector turns a `{tenant}.darwinbox.in` URL into `(darwinbox, tenant)` **without** a network probe. The cloud poll skips these boards. Seeds: `packages/pipeline/src/seeds-local.ts`. |
| **Peerlist** | `peerlist` | `tier3_poll` | A discovery feed of startup and big-company roles: the server-rendered `/jobs/role/{role}` pages (50 per page, newest first). Cloudflare challenged a burst of 3 quick loads during testing, so reads are spaced out and capped. The agent never tries to solve a challenge: a challenge page parses as "no data". |
| **Wellfound** (local path) | `wellfound` | `tier3_poll` | The same pages and parser as the cloud Wellfound adapter, loaded in your browser. The cloud adapter can be challenged from datacenter IPs. Postings keep the same id (`wellfound:<id>`) whichever side fetched them, so they never duplicate. |

### Polling & discovery (cloud-safe)
| Var | Default | What it does |
|---|---|---|
| `JOBFLOW_POLL_EVERY_HOURS` | `6` | The worker `runner` self-enqueues discover → poll → rank when the last full poll is older than this. `0` disables (use an external cron instead). A local/Docker DB has no other scheduler — the GitHub cron can't reach it. |
| `JOBFLOW_POLL_COUNTRY` | `IN` | ISO country the big-employer boards (Workday, Eightfold, SmartRecruiters, Amazon) are polled for — they filter server-side and otherwise return thousands of global roles. Shapes what is polled; ranking still scores location. |
| `JOBFLOW_TELEGRAM_CHANNELS` | `gocareers,techuprise_updates,dot_aware` | csv of public Telegram channels to harvest each poll (set it empty to turn harvesting off). Links to company ATS/careers pages become registered boards; the posting itself is always fetched from the board. Scam-pattern posts and posts older than 30 days are skipped; course-funnel / blog / shortener links are dropped. The defaults won a 2026-09 review of ~100 Indian job channels (54–72% direct company links, 1–4 YoE focus, no scams). Optional extras: `jobsinternshipswale` (small, unique), `itreferral_jobs` (LinkedIn-heavy), `remote_devops_jobs` (DevOps/SRE). The big "freshers" channels route 90%+ of links through ad-funded blogs and are skipped. One-off: `pnpm --filter @jobflow/cli harvest --telegram a,b` or `--whatsapp ./export.txt` (a WhatsApp "Export chat" file — never automated). |

### Misc
| Var | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | standard. |

---

## External services — where to get keys (all optional / free-tier)

1. **Supabase (local now → hosted later).** Local needs Docker only (`npx supabase start`). To deploy: create a project at supabase.com, copy its connection string into `DATABASE_URL` (and run `pnpm --filter @jobflow/db migrate` against it), set `SUPABASE_URL`/keys. The schema + RLS already target Supabase.
2. **Adzuna** — register at developer.adzuna.com → get `app_id` + `app_key` (free tier). Add to `.env` to turn on India-aware salary estimates.
3. **LLM** — pick one provider and add its key; set `LLM_PROVIDER`. Optional — `echo` runs the whole app offline.
4. **levels.fyi** — nothing to do; free `.md` endpoint, attribution rendered on the company page.

---

## Optional sources

Extra discovery feeds for more India coverage. They're wired into `DEFAULT_DISCOVERY_FEEDS` (`packages/pipeline/src/poll.ts`) but **key-gated**: until the key is in `.env`, the adapter returns nothing and makes **no network call**, so a fresh install is unaffected. All of them are cloud-safe documented APIs (Tier 1–2). None holds a user session.

| Source | Env vars | Cost | What it adds |
|---|---|---|---|
| **Adzuna India search** | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` (the same keys as salary enrichment) | free key (developer.adzuna.com; ~250 calls/day, shared with the enricher) | A broad India aggregator. Feed: title-only `backend` / `software engineer`, `max_days_old=14`, newest first. Pay is kept only when the ad states it; Adzuna's own *predicted* salaries are dropped. |
| **Careerjet** | `CAREERJET_API_KEY`, optional `CAREERJET_USER_IP` | free publisher account (careerjet.co.in → Partners → Job search API) | The careerjet.co.in (`en_IN`) index, newest first. Uses the v4 API (`search.api.careerjet.net/v4/query`, Basic auth with the key; the old `affid` endpoint is superseded). Careerjet requires the searching user's IP + user agent: set `CAREERJET_USER_IP` to your public IP (default `127.0.0.1`). Links go through Careerjet's `jobviewtrack.com` redirect, and descriptions are 500-char excerpts. |
| **JSearch** (paid) | `JSEARCH_API_KEY` (OpenWeb Ninja) **or** `JSEARCH_RAPIDAPI_KEY` (RapidAPI), `JSEARCH_MIN_HOURS` (default `24`) | paid; free trial tiers are small | The Google-for-Jobs index: Indian boards and employer career sites in one call (up to 100 jobs per request). Prefers the employer's own ATS link when one is listed. **Spend guard:** each feed target is called at most once per `JSEARCH_MIN_HOURS` per worker process. A cron that starts a fresh process per run gets no carry-over, so budget for one call per run. |

Notes:
- **Freshness.** These sources stamp a listing when *they* index it, not when the employer published it, so treat their "posted" dates as approximate.
- **Salary honesty.** Only stated, annual (or monthly ×12) pay with an explicit currency is passed on. A stated salary is high-confidence and can trigger the salary-floor exclusion, so estimates and hourly/daily rates are never used.
- **Not built: Remote Rocketship.** Its Terms (§5) prohibit scraping. The official API (`POST /api/openclaw/jobs`) needs a paid subscription and limits caching of responses to 24 hours (§4), which conflicts with JobFlow storing postings for up to 14 days. Himalayas already covers India-eligible remote roles.

---

## Local agent

See [guides/local-agent.md](guides/local-agent.md) for the step-by-step opt-in.

---

## Running it somewhere else

- **Your own machine, always on** — Docker Compose (`pnpm docker:up`) runs Postgres, the web
  app and the worker; see [getting-started.md](getting-started.md#docker).
- **A shared instance for several people** — see [guides/self-hosting.md](guides/self-hosting.md).
- **Scheduled polling via GitHub Actions** — `.github/workflows/poll.yml` runs
  discover → poll → rank every 6 h against a hosted Postgres (`DATABASE_URL` secret with
  `?sslmode=require`). Forks must enable Actions and add the secrets.
- The **local agent never deploys** — it runs on your machine, in your browser profile.
