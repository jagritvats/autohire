<!--
DRAFT, not yet released. Before publishing:
- Decide on v0.1.0 first: no v0.1.0 tag exists yet, so the CHANGELOG's compare links and
  RELEASE_NOTES_v0.1.0.md's image (feed.png at the v0.1.0 tag) don't resolve. Either tag
  7f550ff ("Prepare v0.1.0") as v0.1.0, or make this the first public release and drop the
  "Upgrading from 0.1" section.
- Bump the version everywhere listed in docs/contributing/releasing.md, rename
  "## [Unreleased]" in CHANGELOG.md to "## [0.2.0] — <date>", and add the [0.2.0] link.
- Attach the assets listed at the end of this file to the GitHub release.
- Delete this comment.
-->
# JobFlow v0.2.0

**A local-first job search engine.** JobFlow finds roles across hundreds of company boards,
ranks them against *your* résumé with honest match cards, tailors your documents from your
own material, and pre-fills applications. Then it stops, so you can review and submit.

This release is about trust in what you see: pay read the way the posting states it (in any
currency and period), a sync you can watch, one card per role instead of one per country,
a fresh look in three styles, and JobFlow as a data source for your AI assistant over MCP.

![The Jobs page](https://raw.githubusercontent.com/jagritvats/jobflow/v0.2.0/docs/screenshots/jobs.png)

## Get started

```bash
git clone https://github.com/jagritvats/jobflow.git && cd jobflow
pnpm install && pnpm -r build
pnpm jobflow init && pnpm jobflow sync    # your résumé, reviewed by you; then fetch and rank jobs
pnpm jobflow serve                        # the web app at http://localhost:3000
```

You don't need an account, a server or an API key. Your data stays in `~/.jobflow`.
`pnpm jobflow init --sample` loads a fictional candidate if you'd like to look around first.
Node 20 or newer and pnpm 9 are required.

## Upgrading from 0.1

```bash
git pull && pnpm install && pnpm -r build
```

The local database migrates itself when it opens (four new migrations: multi-place
locations, store metadata, salary period/basis/equity, sync runs). Postgres deployments run
`pnpm db:migrate` (or `pnpm docker:migrate`). Your first sync after upgrading re-reads stored
postings once (cleaner descriptions and titles, role types, levels, skills, pay units), with
no re-poll. `jobflow renormalize` does it by hand.

## Highlights

- **Pay you can trust.** Salaries are read with their period (year, month, week, day, hour),
  basis (base, OTE, total comp) and equity, in 30+ currencies including lakh and crore. Cards
  show the posting's own figure first, then your currency: "₹30L–45L / yr (≈ $32k–48k)".
  Exchange rates are dated ECB reference rates, refreshed on sync. Your salary floor and
  `--min-salary` compare in one currency, with a margin for rate error. Estimates say how
  rough they are. Choose the display currency and period in Settings or with
  `jobflow config set display.currency USD`.
- **A sync you can watch.** The web header shows when you last synced and when the next sync
  is due. While a sync runs, a panel shows each phase, the boards done and in flight, the
  postings that are new, updated or gone, plain-language errors, time left and a cancel
  button. `jobflow sync` draws the same progress in the terminal. Sync now polls every board
  that is due, most overdue first, within a time budget, instead of a fixed 25 boards.
- **One card per role.** A role posted once per country is one card, the one that fits you
  best, listing where else it is posted. No single company fills your feed: at most 3 of its
  jobs in any 20 cards, and strong jobs are never buried.
- **Better matching.** A new `data_analytics` role type; about 30 more skills recognised
  (SQL, Tableau, Power BI, dbt, Vue, Angular, Swift, Flutter and others); company level ladders
  read conservatively; multi-place and country-only remote locations; European place names in
  local spellings; plainer fit notes that name the right main language; duplicate detection
  that no longer merges different roles.
- **More places to look.** Recruitee, Personio, Teamtailor, BambooHR and Breezy boards from a
  careers URL; Remote OK and Jobicy; a `canada` preset; and verified, much larger `us`,
  `eu-uk` and `global-remote` presets.
- **Use it from your AI assistant.** `jobflow mcp` serves JobFlow over the Model Context
  Protocol to Claude Code, Claude Desktop or any MCP client: live search, your ranked feed,
  one job in full, the tracker, a dry-run apply plan and grounded drafts. It never fills or
  submits a form. See the [AI agents guide](https://github.com/jagritvats/jobflow/blob/v0.2.0/docs/guides/ai-agents-mcp.md).
- **Three styles.** Settings → Appearance switches between **Editorial** (the new default),
  **Classic** and **Spark**, each in light and dark, on every page and on a phone.
- **A logo and brand kit.** App icons, a favicon, a web manifest, share images, and posters
  and a brand sheet in [`brand/`](https://github.com/jagritvats/jobflow/tree/v0.2.0/brand)
  (artwork CC BY 4.0).
- **Videos.** A narrated walkthrough, a trailer, two short guides and three vertical reels,
  attached below. They show fictional demo data only. Transcripts are in
  [docs/guides/video-walkthrough.md](https://github.com/jagritvats/jobflow/blob/v0.2.0/docs/guides/video-walkthrough.md).

## Breaking changes

JobFlow is pre-1.0, so a minor release can change behaviour. In this one:

- The web and API card field `indiaWorkable` is replaced by the region-neutral `workable`
  (your home country, markets and remote regions). `/api/postings?workable=1` is the new
  filter; `?india=1` is still accepted.
- `jobflow sync --full` now polls every due board, and a sync is bounded by time
  (`JOBFLOW_SYNC_MINUTES`) rather than a fixed 25 boards. `JOBFLOW_SYNC_MAX_BOARDS` /
  `--max-boards N` cap a run.
- The web app now saves to the CLI's durable store in `~/.jobflow` by default instead of
  falling back to memory.
- The web app's `/searches` and `/discovery` pages moved to `/search` and `/sources`; the old
  addresses redirect.

The full list is in the
[CHANGELOG](https://github.com/jagritvats/jobflow/blob/v0.2.0/CHANGELOG.md).

## Licence

GNU AGPL-3.0-only. Use it privately however you like. If you distribute it, or run a
modified version as a service for others, share your source under the same licence. The
artwork in `brand/` is CC BY 4.0.

<!--
Assets to attach (gh release create v0.2.0 ... <files>):
Videos, from $VIDEO_OUT/out after `pnpm video` (scripts/video/README.md); none are in git:
- jobflow-walkthrough.mp4 (+ .srt, .poster.png)
- jobflow-trailer.mp4, jobflow-trailer.captioned.mp4, jobflow-trailer.square.mp4 (+ .srt, .poster.png)
- jobflow-guide-get-started.mp4 (+ .srt, .poster.png)
- jobflow-guide-mcp.mp4 (+ .srt, .poster.png)
- reels/jobflow-reel-*.mp4 (3 files, + .srt, .poster.png)
Brand (already in git; attach for convenience):
- brand/brand-sheet.pdf
- brand/posters/poster-{ranked,review-gate,local}-A3-bleed.pdf
- a zip of brand/logo/*.svg (jobflow-logo-svg.zip)
Repository settings: Social preview = brand/social/github-social-preview.png.
-->
