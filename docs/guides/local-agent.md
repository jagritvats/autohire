# The local agent

The local agent is an optional process that runs **on your own machine**, in your own
browser profile. It does two things nothing else in JobFlow does:

- **Pre-fills applications from the web app.** While it's online, each Job page's Apply panel
  shows a **Pre-fill with the local agent** button, so you don't have to stop `jobflow serve`
  and run `jobflow apply <id> --fill` yourself.
- **Reads logged-in job sites (Tier 3).** LinkedIn, Naukri, Glassdoor, AmbitionBox and a few
  anti-bot boards are read only here, in your session, never by `sync`, the web server or
  the worker.

You don't need it for anything else. Discovery, search, ranking, tailoring and `jobflow apply
--fill` all work without it. It's off by default, and turning it on is deliberate.

The agent is the only part that touches your logged-in sessions, so turning it on is intentional and spans env + UI + a running process. **Do all of these; if any one is missing, it stays off.**

0. **Use Postgres, not the default local store.** The agent shares a database with the web
   app, and the default PGlite store under `~/.jobflow` takes one process at a time. If
   `DATABASE_URL` isn't set, the agent prints "DATABASE_URL not set — the agent needs the
   shared DB" and exits. The simplest way is the Docker stack: `pnpm docker:up` runs Postgres
   (on `localhost:5433`), the web app and the worker. Then set
   `DATABASE_URL=postgres://postgres:postgres@localhost:5433/jobflow` in the repo-root `.env` the
   agent reads.
1. **Install Playwright + Chromium** (heavy download, do it when ready):
   ```bash
   pnpm --filter @jobflow/agent exec playwright install chromium
   # (or: cd apps/agent && npx playwright install chromium)
   ```
2. **Set the machine-level gates** in `.env`:
   ```
   JOBFLOW_BROWSER=on
   JOBFLOW_BROWSER_MODE=fill          # only if you want form-fill; else leave 'capture'
   JOBFLOW_BROWSER_PROFILE=~/jobflow-chrome   # a profile logged into LinkedIn/Naukri
   ```
3. **Opt in from the UI:** Settings → Applying & the local agent → tick "let the local agent open a browser for me", and (under "Logged-in job sites") select the Tier-3 sources you want (`naukri`, `linkedin`, `peerlist`, `wellfound`, `darwinbox`, …). Save.
4. **Run the agent:** `pnpm --filter @jobflow/agent start`. It heartbeats every 30s; while it's online, each Job page's Apply panel shows a **Pre-fill with the local agent** button (and Sources → Sync → Maintenance shows the agent's queue).
5. **Use it:** the Job page's "Pre-fill" button enqueues `form_fill` (the agent opens the form in your browser, fills it, **stops at review** — you submit); Settings "search {source}" buttons enqueue `tier3_poll`, which runs the good-paying-India-SWE sweep (query × tech-hub × CTC floor) in your session and then enqueues a `rank` so the new postings surface in the feed. Override the sweep per-run via the job payload (`queries`, `locations`, `minLpa`, `limit`, `maxTargets`) or globally via the `JOBFLOW_TIER3_*` env vars above. `local_board_poll` (payload `{}` for every local-only board, or `{ "companyId": "…" }` for one) polls the Darwinbox boards.
6. **Unattended (optional):** leave the agent running. Every `JOBFLOW_LOCAL_POLL_EVERY_HOURS` (default 12), it enqueues one job per opted-in source whose last run is older than that, skipping sources that already have a job queued. Each run of jobs ends with a single `rank`. Set `0` to keep it click-only.

**Honest caveats:**
- Tier-3 site selectors (Naukri/LinkedIn/Glassdoor/AmbitionBox) are **best-effort and need tuning** for your session/locale — the framework (your-session fetch, flag-guard, normalize→upsert) is built; the per-site parsing is the part to refine on your machine.
- **Naukri "posted" dates:** a Naukri job id starts with `DDMMYY`, reportedly the date the job was *first* posted. A "refreshed" listing then shows a recent date but keeps its old id. When the id date is a real date, is within the last year, and is more than 2 days older than the displayed date, it's used as `postedAt` (both are kept in `raw` for audit). Search-index data supports the id format. The refresh behaviour itself was **not** verified live: Naukri answered `403 Access Denied` to an automated browser, and we stopped rather than work around it. If you see odd dates, check `raw.displayedPostedAt`.
- **Naukri consultancy flag:** `postedByAgency` is set only when a tuple carries an explicit boolean (`consultant` / `isConsultant` / …). The exact key in search results is unverified, so check a few in your session.
- The anti-bot sources (Darwinbox, Peerlist, Wellfound) use no stealth tricks. If a site challenges your browser, that run returns nothing and the next scheduled run tries again. Solve challenges yourself in the agent's browser if you like; the agent never does.
- Form-fill **never submits** — there is no code path that clicks submit (`assertNeverSubmits`), and `JOBFLOW_AUTOSUBMIT` is hard-false.
- This runs against your real accounts at human pace; it's your risk to accept, which is why it's off by default and isolated.


See [Applying](apply.md) for the review gate it shares with `jobflow apply --fill`,
[Legal & ethics](../legal-and-ethics.md) for the tiers, and the agent's environment variables
in the [configuration reference](../configuration.md).
