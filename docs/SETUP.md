# JobFlow — Setup & Configuration

Everything you need to configure, and what's optional. **What already works with zero setup** vs **what you'll set up later** is called out explicitly. Secrets live in the gitignored root `.env` (loaded by every process via a small root-env loader; Next loads it via `next.config.mjs`).

---

## TL;DR — current state

Already wired on this machine (don't need to redo):
- ✅ Local Supabase running (Docker, project `jobflow`, ports `553xx`), `.env` has the connection string, migrations applied.
- ✅ `echo` LLM (offline stub) — the app runs, re-ranks, and generates placeholder narratives with **no API key**.
- ✅ levels.fyi comp enrichment (free, no key).

Run the platform:
```bash
pnpm install && pnpm -r build
pnpm web                                  # control plane  → http://localhost:3000
pnpm --filter @jobflow/worker runner      # cloud job-runner (poll/discover/rank/enrich)
# optional, Phase 4 (off by default):
pnpm --filter @jobflow/agent start        # local agent (Tier-3 + form-fill)
```

The three processes are the three planes: **web** (control + UI), **worker** (cloud Tier 1-2), **agent** (local Tier 3 + form-fill).

---

## Run with Docker (one command)

The cloud planes are containerized — **Postgres + migrate + web + worker** in one compose file. The local agent is **not** (Tier-3 needs your own logged-in browser; invariant #1).

```bash
pnpm docker:up        # docker compose up -d --build  → builds, migrates, starts web+worker
#   web    → http://localhost:3000
#   db     → localhost:5433  (pgvector/pgvector:pg16, named volume `jobflow-db`)
pnpm docker:logs      # tail web + worker
pnpm docker:migrate   # re-run migrations on demand (one-shot service)
pnpm docker:down      # stop;  add `-- --volumes` to drop the DB volume
```

- **Keys**: compose reads your gitignored root `.env` via `${VAR}` interpolation
  (`LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `ADZUNA_*`).
  `DATABASE_URL` is forced to the in-stack `db` service, so you don't point at Supabase.
- **LaTeX → PDF** in the web image: the `web` target installs a slim TeX Live so
  `/api/resume/pdf` compiles. Skip it with `INSTALL_LATEX=0 pnpm docker:up` (smaller image;
  the `.tex` download still works).
- **Agent**: run it on your machine against the same DB — set `DATABASE_URL` in `.env` to
  `postgres://postgres:postgres@localhost:5433/jobflow` and `pnpm agent`.

The first `web` build is slow (TeX + `next build`); subsequent `pnpm docker:up` are cached.

---

## Environment variables (full reference)

All in the root `.env`. Grouped by what they unlock.

### Database / persistence
| Var | Required? | What it does |
|---|---|---|
| `DATABASE_URL` | **for durable mode** | Postgres connection string. Set → durable (Supabase/VPS); unset → in-memory (dev). Local Supabase value already in `.env`. |
| `SUPABASE_URL` | optional | Supabase API URL (for Realtime/auth in later phases). |
| `SUPABASE_ANON_KEY` | optional | Public client key (later phases). |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | Service key (RLS-bypassing); used if a future repo path uses supabase-js. |

### LLM (re-rank narratives, grounded answers/resume)
| Var | Required? | What it does |
|---|---|---|
| `LLM_PROVIDER` | optional | `echo` (default, offline) · `anthropic` · `grok` · `openai`. |
| `LLM_MODEL_CHEAP` | optional | cheap model for normalize/titles (e.g. `claude-haiku-4-5-20251001`). |
| `LLM_MODEL_STRONG` | optional | strong model for re-rank/answers (e.g. `claude-opus-4-8`). |
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
| `TENANT_ID` | the default uuid | Single-tenant id; multi-tenant later. |
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

## Enabling the local agent (the deliberate, multi-step opt-in)

The agent is the only part that touches your logged-in sessions, so turning it on is intentional and spans env + UI + a running process. **Do all of these; any one missing keeps it off.**

1. **Install Playwright + Chromium** (heavy download, do it when ready):
   ```bash
   pnpm --filter @jobflow/agent exec playwright install chromium
   # (or: cd apps/agent && npx playwright install chromium)
   ```
2. **Set the machine-level gates** in `.env`:
   ```
   JOBFLOW_BROWSER=on
   JOBFLOW_BROWSER_MODE=fill          # only if you want form-fill; else leave 'capture'
   JOBFLOW_BROWSER_PROFILE=C:\Users\you\jobflow-chrome   # a profile logged into LinkedIn/Naukri
   ```
3. **Opt in from the UI:** Settings → Automation → toggle "browser automation (master)" on, and select the Tier-3 sources you want (`naukri`, `linkedin`, `peerlist`, `wellfound`, `darwinbox`, …). Save.
4. **Run the agent:** `pnpm --filter @jobflow/agent start`. It heartbeats every 30s → the feed's "local agent" pill goes green and shows the enabled sources.
5. **Use it:** the feed/CRM "fill" buttons enqueue `form_fill` (the agent opens the form in your browser, fills it, **stops at review** — you submit); Settings "browse {source}" buttons enqueue `tier3_poll`, which runs the good-paying-India-SWE sweep (query × tech-hub × CTC floor) in your session and then enqueues a `rank` so the new postings surface in the feed. Override the sweep per-run via the job payload (`queries`, `locations`, `minLpa`, `limit`, `maxTargets`) or globally via the `JOBFLOW_TIER3_*` env vars above. `local_board_poll` (payload `{}` for every local-only board, or `{ "companyId": "…" }` for one) polls the Darwinbox boards.
6. **Unattended (optional):** leave the agent running. Every `JOBFLOW_LOCAL_POLL_EVERY_HOURS` (default 12), it enqueues one job per opted-in source whose last run is older than that, skipping sources that already have a job queued. Each run of jobs ends with a single `rank`. Set `0` to keep it click-only.

**Honest caveats:**
- Tier-3 site selectors (Naukri/LinkedIn/Glassdoor/AmbitionBox) are **best-effort and need tuning** for your session/locale — the framework (your-session fetch, flag-guard, normalize→upsert) is built; the per-site parsing is the part to refine on your machine.
- **Naukri "posted" dates:** a Naukri job id starts with `DDMMYY`, reportedly the date the job was *first* posted. A "refreshed" listing then shows a recent date but keeps its old id. When the id date is a real date, is within the last year, and is more than 2 days older than the displayed date, it's used as `postedAt` (both are kept in `raw` for audit). Search-index data supports the id format. The refresh behaviour itself was **not** verified live: Naukri answered `403 Access Denied` to an automated browser, and we stopped rather than work around it. If you see odd dates, check `raw.displayedPostedAt`.
- **Naukri consultancy flag:** `postedByAgency` is set only when a tuple carries an explicit boolean (`consultant` / `isConsultant` / …). The exact key in search results is unverified, so check a few in your session.
- The anti-bot sources (Darwinbox, Peerlist, Wellfound) use no stealth tricks. If a site challenges your browser, that run returns nothing and the next scheduled run tries again. Solve challenges yourself in the agent's browser if you like; the agent never does.
- Form-fill **never submits** — there is no code path that clicks submit (`assertNeverSubmits`), and `JOBFLOW_AUTOSUBMIT` is hard-false.
- This runs against your real accounts at human pace; it's your risk to accept, which is why it's off by default and isolated.

---

## Deploying later (when you move off local)

- **Web** → Vercel/Netlify free tier. Set the same env vars in the host's dashboard (`DATABASE_URL` to the hosted Supabase, `LLM_PROVIDER`+key, `ADZUNA_*`). The agent does **not** deploy — it stays on your machine.
- **Worker cron** → the included GitHub Action (`.github/workflows/poll.yml`) runs `discover|poll|rank` every 6h. Set repo **secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`/`XAI_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`; and repo **variable** `LLM_PROVIDER`. Or run it on your Vultr VPS under PM2 (`pnpm --filter @jobflow/worker runner` long-lived + `start` on a cron).
- **Local agent** → PM2 on your machine (`pnpm --filter @jobflow/agent start`) with the env gates set; it connects to the hosted DB and drains your `runtime=local` jobs.

---

## "Set up later" checklist (deferred)

- [ ] Adzuna `app_id` + `app_key` → India-aware salary estimates.
- [ ] Pick a real `LLM_PROVIDER` + key → real re-rank narratives + grounded answers/resume.
- [ ] Hosted Supabase project (when deploying) + `migrate` against it.
- [ ] Vercel deploy of the web app (+ env vars).
- [ ] GitHub Actions secrets for the cron worker.
- [ ] Local agent: `playwright install chromium`, set `JOBFLOW_BROWSER*` + `JOBFLOW_BROWSER_PROFILE`, opt-in sources in Settings, run the agent.
- [ ] Tune Tier-3 selectors (Naukri/LinkedIn/Glassdoor/AmbitionBox) for your session.
- [ ] (Optional) Calendar wiring for `next_action_at` reminders.
