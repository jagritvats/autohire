# Applying

JobFlow helps you apply well — tailored, grounded documents and a pre-filled form — and then
**stops**. You review every field and click submit yourself. That isn't a missing feature;
it's the point: what goes out in your name should be something you've read.

## From the CLI

```bash
pnpm jobflow tailor '#1'                    # résumé bullet variants for this posting
pnpm jobflow tailor '#1' --kind resume-latex --pdf --out cv.pdf   # needs tectonic for --pdf
pnpm jobflow tailor '#1' --kind cover --note "I use your product daily"
pnpm jobflow apply '#1'                     # dry run: the fill plan + which résumé file
pnpm jobflow apply '#1' --open              # open the application in your browser
pnpm jobflow apply '#1' --fill              # fill it in a local browser, then stop for review
pnpm jobflow track status '#1' applied      # once YOU have submitted
```

`--fill` needs Playwright once:

```bash
pnpm add -w playwright
npx playwright install chromium
```

Form filling is off by default; switch it on once with `pnpm jobflow config set automation.fill on`.

It opens the form in a persistent browser profile under `~/.jobflow/browser-profile`
(log in to sites there once if they need it), types only the contact details and answers
you stored, attaches your tailored résumé (or base résumé), and waits. Greenhouse, Lever,
Ashby, Workable and Workday forms have dedicated field maps; anything else gets a cautious
generic map.

### Guarantees

- There is **no submit option** and no code path that clicks submit, presses Enter on a
  form or dispatches a submit event. `JOBFLOW_AUTOSUBMIT` is hard-wired to `false`, and
  `assertNeverSubmits()` throws if it isn't. Tests enforce this.
- Only stored values are typed. Nothing is generated at fill time.
- Prose (cover letters, answers) requires a real model and is grounded in your résumé and
  Evidence Bank; with the offline `echo` provider, documents fall back to your own résumé
  reformatted (labelled `builtin`) and prose refuses rather than inventing.

## Tracking

```bash
pnpm jobflow track list
pnpm jobflow track add '#3'
pnpm jobflow track status '#3' interviewing --note "Onsite next week"
pnpm jobflow track next '#3' "Send thank-you" --due 2026-12-01
```

The feed marks postings you've already tracked or applied to (don't-double-apply).

## The local agent (Tier-3 sources + filling from the web app)

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
   JOBFLOW_BROWSER_PROFILE=~/jobflow-chrome   # a profile logged into LinkedIn/Naukri
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

## Browser extension

The MV3 extension (`apps/extension`) adds a match panel to job pages you're viewing and a
"capture" button that saves the posting to your feed. It's read-only — it never fills or
submits. Load it unpacked from `chrome://extensions` (Developer mode → Load unpacked →
`apps/extension`); by default it talks to `http://localhost:3000` (`jobflow serve`), and its
options page lets you point it at another server with an API token.
