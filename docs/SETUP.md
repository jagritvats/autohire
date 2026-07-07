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
| `JOBFLOW_TIER3_SOURCES` | _(empty)_ | Optional env allow-list (csv: `naukri,linkedin,glassdoor,ambitionbox`). If set, restricts which sources the web can enable. |
| `JOBFLOW_BROWSER_PROFILE` | `.jobflow/browser-profile` | Path to the Chromium user-data dir the agent drives — point it at a profile **logged into** LinkedIn/Naukri/etc. |

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
3. **Opt in from the UI:** Settings → Automation → toggle "browser automation (master)" on, and select the Tier-3 sources you want (`naukri`, `linkedin`, …). Save.
4. **Run the agent:** `pnpm --filter @jobflow/agent start`. It heartbeats every 30s → the feed's "local agent" pill goes green and shows the enabled sources.
5. **Use it:** the feed/CRM "fill" buttons enqueue `form_fill` (the agent opens the form in your browser, fills it, **stops at review** — you submit); Settings "browse {source}" buttons enqueue `tier3_poll`.

**Honest caveats:**
- Tier-3 site selectors (Naukri/LinkedIn/Glassdoor/AmbitionBox) are **best-effort and need tuning** for your session/locale — the framework (your-session fetch, flag-guard, normalize→upsert) is built; the per-site parsing is the part to refine on your machine.
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
