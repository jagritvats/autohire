# Discovery and data-quality audit (2026-11-18)

What the pipeline actually produces on live data: dedup, normalization, freshness,
scheduling, discovery and ranking, measured, fixed where the data showed a real defect,
and re-measured. Regression tests for every fix are in
`packages/core/test/discovery-audit.test.ts` and `packages/pipeline/test/discovery-audit.test.ts`
(minimised, fictionalised fixtures, no live HTTP).

## Method

Two throwaway PGlite corpora, each built with one live `jobflow sync --full`:

| Corpus | Profile | Presets | Boards polled | Active postings |
|---|---|---|---|---|
| IN | fictional sample persona (3 yrs, Java/Kafka, home IN, floor ₹20 L) | `india` | 79 of 247 + 12 feeds (236 s) | 8,851 |
| US | go/python/k8s/aws/postgres, home US, remote `worldwide,us_only`, floor $140 k (ranked at 6 yrs / senior) | `us`, `global-remote` | 45 of 47 + 5 feeds (130 s) | 11,935 |

Analysis scripts (not committed) opened the stores read-only, dumped them to JSON and
re-ran the current core on stored fields. Location needs the raw `locationRaw`, which isn't
stored, so one polite capture of raw postings (2 boards per ATS type plus the presets'
feeds: 4,623 IN / 4,822 US raws) was diffed old-parser vs new-parser. "After" ranking
numbers come from a copy of each corpus re-polled once with the fixed code (same boards,
same feeds), with title/skills/experience re-derived from stored text where a board's lite
listing skipped the re-upsert.

Hand checks: ~160 distinct location strings per corpus, ~150 titles, 55 stated-salary
parses per corpus (40 `high` + 15 lower), every ≥15-year experience parse on the IN raw
sample, the top 60 of each ranking and samples of every hard-exclusion reason.

## Findings and fixes

### 1. Dedup hid 43–45% of every corpus (fixed)

`rebuildMatches` scores only canonical postings, so a dedup false merge removes a role
from the feed entirely.

- Stage 1 keyed on `titleNorm`, a coarse role family: every title containing "software
  engineer" (or "developer") became `software-engineer`. At one company and city, 60+
  distinct roles ("Senior Software Engineer, Backend (Consumer)", "… (Retail)", "Staff
  Software Engineer, Compute Platform" and even "Group Product Manager, Developer
  Infrastructure") shared one key, and the canonical winner was simply the first row (in
  one cluster a PM role stood for the whole engineering org).
- Stage 2 merged any same-company pair whose JD embeddings were ≥0.92 alike. With the
  offline embedder that's boilerplate: a company's account executives, solutions
  consultants and Android/iOS engineers became one card.
- Genuine cross-source duplicates were rare: 5 (IN) / 7 (US) clusters.

| | IN before | IN after | US before | US after |
|---|---|---|---|---|
| canonical / active | 5,061 / 8,851 | 8,043 / 8,851 | 6,547 / 11,935 | 11,274 / 11,935 |
| hidden by dedup | **42.8%** | **9.1%** | **45.1%** | **5.5%** |
| engineering roles hidden | 1,222 | 218 | 1,856 | 176 |
| cross-source clusters | 6 | 9 | 7 | 6 |

Fix: the key uses `dedupTitleKey` (team, specialty and level kept; only phrasing noise
collapses: "Sr."/"Senior", "II"/"2", "Developer"/"Engineer", "SDE"/"Software Engineer",
word order, req ids, location/employment tags) plus a city alias table (Bangalore =
Bengaluru, Gurgaon = Gurugram, NYC = New York …). `dedup()` recomputes the key from the
posting, because the Postgres upsert does not refresh `dedup_key` on conflict. Stage 2
merges only across sources, same level, a compatible location and a near-identical title
(token Jaccard ≥0.8, or ≥0.5 confirmed by the embedding). Every remaining multi-member
cluster sampled is the same role (identical titles in one city, or one role on a board
plus an aggregator). `rebuildMatches` now clears canonical pointers that no longer hold:
the pre-onboarding browse feed hides anything with a pointer, so old false merges would
otherwise stay hidden there forever. ATS boards still win every cross-source cluster (0
clusters where an aggregator won), now pinned by a test over every `AtsType`, including
the new Teamtailor/BambooHR/Breezy boards.

### 2. Skills: substring aliases (fixed)

| skill | IN tags before | after | why |
|---|---|---|---|
| scala | 3,403 | 358 | "scalable", "scalability" |
| rust | 3,298 | 115 | "trust", "frustrating" |
| ml | 5,232 | 2,693 | "storage", "leverage", "average" ⊃ "rag" |
| distributed_systems | 1,818 | 1,057 | "consensus" (stakeholders), "draft" ⊃ "raft" |
| kubernetes | 1,142 | 827 | "weeks" ⊃ "eks", "overwhelm" ⊃ "helm" |
| react | 629 | 450 | "reactive", "react to incidents" |
| javascript | 908 | 746 | "a single node" |

These fed stack adjacency (a Java user scored "Scala-adjacent" on half the corpus) and
"JD requires Rust" stretch flags. Fix: whole-word aliases for JDs too, inflections listed
explicitly (LLMs, Dockerized, microservice), React by its capitalised name or a tech cue.

### 3. Experience: the employer's age read as a requirement (fixed)

~200 IN postings carried a 25–40-year "requirement" from company boilerplate (Tower
Research "25+ year track record" ×83, Cisco "innovating for 40 years" ×60, Cadence "more
than 30 years" ×23, PayPal and Nvidia "for more than 25 years" ×33, Micron, Databricks).
Each scored seniority 0.1 ("not your role yet"), which with the feasibility damping sank
whole employers. Fix: floors above 20 years are dropped, plus "track record" / "after N
years" / "innovating for" rejections. After: min ≥15 on the IN raw sample 169 → 105, every
remaining one a real "15+ years" ask; no 25/30/40 left.

### 4. Titles: team suffixes and Amazon's SDE (fixed)

The non-engineering guard ran over the whole title, so "Software Engineer, Financial
Business Insights", "Senior Software Engineer - Marketplace", "Backend Software Engineer -
Codex for Finance" and "Software Engineer, Full Stack (People …)" were `other` (archetype
0.08, "Non-engineering role"). "Software Development Engineer" / "Software Dev Engineer"
(500 Amazon rows on the IN corpus) matched no pattern at all. Fix: the guard reads the
role head (before the first comma, dash, parenthesis or "for"); SDE forms map to backend;
web/CMS developers to fullstack. Engineering titles on the raw samples: IN 1,254 → 1,409,
US 1,223 → 1,348. Sales/solutions engineers, PMs and "Software Development Manager" stay
non-engineering.

### 5. Location (fixed)

Old vs new parser on the raw samples:

| | IN old | IN new | US old | US new |
|---|---|---|---|---|
| no country | 463 (10%) | 41 (0.9%) | 784 (16%) | 152 (3.2%) |
| confidence < 0.5 | 387 | 21 | 572 | 95 |
| remote → worldwide | 45 | 13 | 69 | 32 |

- **False "worldwide" at 0.9 confidence.** A bare "worldwide" anywhere in the JD ("customers
  worldwide") made `Remote - California`, `Remote - Texas`, `Remote - Pennsylvania`, `Remote -
  China` worldwide roles: top marks and a +0.1 bonus for a user in India. Now only
  remote-anchored phrasings count, and US states / Canadian provinces resolve.
- **No country outside IN/US/CA/Europe.** Onsite Tokyo, Singapore, Seoul, Sydney, Bangkok
  (226 rows), Mexico City, São Paulo, Tel Aviv had `country: null`: never "abroad", so no
  visa discount or flag for anyone. 35 countries are now named (ISO-mapped, so
  `parsedCountryMatches` and home-country inference work), plus more European places,
  Ashby's ISO-prefixed `JP-Tokyo` / `US-CA-Menlo Park` / `Fins Only-AU-Sydney`, and
  "N Locations" placeholders.
- **`US-CA-Dublin` read as Ireland**, making a US-only role `us_eu`.
- **Single-country remote.** "Remote Singapore" was `us_only@0.5` from a stray "US" in the
  JD, which a US profile treats as open; "Remote - Brazil" was `unknown@0.35`; "Remote -
  Canada" was filed under `us_only` (the Americas bucket), so Affirm's separate Canada reqs
  ranked in a US user's top 20. These now keep their country (`remoteGeo: unknown`,
  confidence 0.8) and the scorer treats remote-within-a-named-foreign-country as a soft
  down-weight with a flag ("usually requires living there"), open when the country is home
  or a market. Not a hard filter (invariant #4); for a user in India, "Remote - Canada"
  moved from hard-excluded to strongly down-weighted.

### 6. Salary (one fix; otherwise clean)

Stated pay on 2,495 (IN) / 7,131 (US) postings; 2,411 / 6,599 `high`. All 80 hand-checked
`high` bands were correct (the sampled currency/location mismatches were genuine, e.g. a
Paris internship stating USD); 0 odd bands. One dangerous case: Wellfound bands like "₹2L –
₹2.5L" on a senior backend role (4+ yrs) and "₹1.2L – ₹1.6L" with equity are almost
certainly monthly, yet parsed `high` and hard-excluded under the ₹20 L floor. An undated
INR band below ₹3 L/yr is now `medium_high`, which the floor never acts on. Salary
exclusions on the IN profile: 24 → 19, all remaining are stated annual bands (LPA, ranges in
lakhs) or intern stipends. `pnpm --filter @jobflow/worker salary` on the re-polled IN
corpus: 0 bands changed (the re-poll had already re-parsed them), 5,347 estimates refreshed.
`salary-backtest` (leak-free, calibrated), before → after: overall median error 18% → 18%,
≥0.70 bucket 10% → 10%, <0.30 bucket 40% → 40%; but the two middle buckets now read 19% /
21% (0.30–0.50 / 0.50–0.70; before 24% / 17%) — no longer strictly monotonic. The cause is
the location fixes: remote roles once mislabelled "worldwide" moved from the REMOTE pay
market (41 comparables → 1) into US, and ~3,000 formerly hidden postings joined the
comparables. **Follow-up (pipeline/salary.ts):** re-fit the confidence calibration on the
new market mix. *Done (per market × role family): see Follow-ups.*

### 7. Freshness, staleness and scheduling (fixed)

- **Board coverage.** After one full sync (cap 80), 168 of 247 IN boards had never been
  polled (Workday: 16 of 113). Never-polled boards came first, but in registry order, and
  the 41 daily-cadence seed boards were reached last. Simulated on the live registry
  (default 25-board sync): old and new both reach every board by sync 10 (2 syncs/day),
  but the last daily board is first polled at sync 2 instead of 10, and the first sweep is
  round-robin across ATS types. Cadence weighting beyond `dueForPoll` was simulated and
  rejected: at this cap the due boards need more than a run holds (243 boards, 41 daily),
  and favouring daily boards stretched the time to reach every board to 14–19 syncs and
  weekly re-polls to 10–20 days.
- **The cap itself is the bottleneck.** With 25 boards a sync, a 243-board registry gets each
  board, daily ones included, re-polled every 5–10 days whatever the order. **Recommendation
  (service/CLI owners):** size the default `maxBoards` from the registry (or a time budget)
  rather than a fixed 25. *Done (every due board inside a time budget): see Follow-ups.*
- **TTL sweep without a fetch.** The 21-day board sweep retired every posting unseen for 21
  days, including postings of boards the cap simply hadn't reached: a stale mark with no
  fetch behind it (invariant #5). On a registry where a rotation takes longer than 21 days,
  that retires live roles. It now retires only postings whose board was fetched since they
  were last seen (an empty, partial or capped list), plus postings of paused/removed or
  non-cloud boards. Partial / `markPartial` lists still never run `markStale`.
- **A board whose fetch throws** (Workday threw once in each live run: "Cannot read
  properties of undefined (reading 'match')", Mastercard then Cisco) was never marked polled,
  so it sorted first every run and held a slot. Now it takes its turn.
- **Capped polls** (`limitPerCompany`, the default bounded sync) upserted the same first N
  roles every time, so a board's later roles never landed. Unstored roles now go first.
- **Live churn:** re-polling ~45 minutes after the first sync, `markStale` retired 30 (IN) / 8
  (US) postings that had genuinely left their boards; FEED_TTL expired nothing (as expected
  inside 14 days).
- **Dates:** 0 future dates; 380 IN postings older than a year, almost all Greenhouse
  evergreen / talent-community reqs, which freshness already caps and flags.
- **Liveness coverage:** `isLive` exists for Greenhouse, Lever, Workday, Amazon,
  SmartRecruiters, Cutshort, Instahyre, TimesJobs and the new boards, but not for Ashby,
  Hirist, Wellfound, Himalayas, HN or Remotive, which hold a large share of the IN top 60.

### 8. Discovery (one fix; rest for other owners)

- Seed resolution: IN 199 of 202 (Zerodha, Setu, Juspay unresolved); US 39 of 52 (Asana,
  Airtable, Webflow, Retool, Vanta, Canonical, Grafana Labs, Zapier, Doist, Sourcegraph,
  Hotjar, Deel, Automattic unresolved, so name-probing found no board).
- Community harvesting registered 32 boards in a week; 2 duplicated a board already held
  under a slug-guessed name ("Thomsonreuters", "Gevernova"), and Oracle boards were named
  by their whole host ("Ebxr.Fa.Us2.Oraclecloud.Com/CX 1"). Fixed: a link to a known
  `(atsType, atsSlug)` re-tags that company; Oracle boards take the tenant code.
- Boards polled with 0 postings: Freshteam "locus", Eightfold Qualcomm (and Microsoft in
  the capture).

### 9. Ranking (before → after)

Quality proxies, from current parsers over stored text ("good" = target archetype,
workable from the user's markets / remote geos, IC level):

| | IN before | IN after | US before | US after |
|---|---|---|---|---|
| good candidates reachable in the ranking | 384 of 916 | 765 of 927 | 140 of 695 | 649 of 698 |
| top 50: target archetype | 48 | 50 | 34 | 46 |
| top 100: target archetype | 98 | 100 | 52 | 86 |
| top 100: workable from markets | 100 | 100 | 96 | 100 |
| hard exclusions | 379 | 719 | 137 | 286 |

The exclusion counts rose because ~3,000 (IN) / ~4,700 (US) more postings are now scored,
and the remote roles once mislabelled worldwide are now correctly restricted. Every sampled
exclusion was right (US-only or EU-only remote at ≥0.85, stated annual pay below 70% of the
floor, onsite abroad without sponsorship).

Remaining ranking observations, not fixed here:

- **Company concentration.** With false merges gone, big boards with many good-fit roles
  dominate: Amazon holds 19 of the IN top 50, Nvidia and Affirm 8–15 of the US top 50. The
  scores are honest; a per-company interleave or "+N more from Amazon" belongs in the feed
  presentation (`packages/service/src/feed.ts`), not in the score.
- A job **seeker's** "Who wants to be hired"-style post (a person's name as company) ranks
  #1–2 for the IN profile and in the US top 5 (HN adapter).
- Consultancies stay unflagged: 0 postings carry `postedByAgency`, and names such as
  "… Consultancy", "HiringBlaze", "Staffision" or "… HireTech" slip past `CONSULTANCY_NAME_RE`
  (5+ in the IN top 60).

## For other owners

- **Adapters** (`packages/adapters/**`, `core/match/trust.ts` entries):
  - `hn/`: drop job-seeker self-posts ("I'm a software engineer focused on …").
  - `ats/workday.ts`: intermittent throw "Cannot read properties of undefined (reading
    'match')" (Mastercard, Cisco); adapters should return `[]`.
  - `core/match/trust.ts`: widen `CONSULTANCY_NAME_RE` (consultancy / hiretech / staffing-brand
    names seen on Hirist and Himalayas).
  - `ats/eightfold.ts` (Qualcomm, Microsoft) and `ats/freshteam.ts` ("locus"): 0 postings.
  - `isLive` for Ashby, Hirist, Wellfound and Himalayas would cover most of the IN top cards.
  - No `RemoteGeo` exists for a single country or for Canada; "Remote - Canada" / "Remote -
    Brazil" are now `unknown` + a country. A `country_only` (or per-country) geo in the enum
    would let views and the hard rule reason about them directly.
- **Presets** (`packages/pipeline/src/presets/**`, `seeds-*.ts`): give the 13 unresolved US
  / global-remote seeds and Zerodha, Setu, Juspay a `careersUrl` (name probing finds no board).
- **db** (`packages/db/src/postgres.ts`, `memory.ts`): the upsert does not refresh
  `dedup_key` (or `company_id`) on conflict, so stored keys keep whatever key existed when the
  row was first written; `dedup()` now recomputes them. `setCanonical` should accept `null`
  (the pipeline passes it with a cast to clear a stale pointer). *Done: see Follow-ups.*
- **service / CLI**: scale the default sync's `maxBoards` with the registry; consider a
  per-company interleave in the feed. *Done: see Follow-ups.*

## Follow-ups (2026-11-18, second pass)

The db, sync, feed and salary items above, done; the single-country remote geo, designed and
then built (with multi-country locations, below).

### db: dedup key refresh and clearing canonical pointers (done)

The posting upsert now refreshes `dedup_key` and `company_name` on conflict; the row's
identity (`company_id`, `source`, `tier`, `first_seen`) stays with the first write, and
`InMemoryRepository` behaves the same (it used to overwrite all of them through a spread).
`setCanonical(id, null)` clears a pointer, so `rebuildMatches` drops its cast. Both are in
the contract test on memory and PGlite. `dedup()` still recomputes the key from the posting
on purpose: a row not re-polled since a key-algorithm change keeps the old key until its
next poll.

### Sync coverage: every due board, inside a time budget (done)

`pollAll`'s default board budget is now `"auto"`: every **due** board (the `dueForPoll` list
already encodes cadence: daily boards come due after 20 h, weekly ones after 6 days, new ones
at once), so the budget grows with the registry. Two bounds keep a run sane: a time budget
(no new board starts after it; the rest stay due and lead the next run: 5 min for `jobflow
sync` and the web app, 10 min for the worker, 60 s for the request-bound refresh, none for
`--full`), and the existing concurrency (8) and per-host limit (2). A registry's very first
sync is capped at 25 boards / 90 s so the first feed comes fast; the web app's local
schedule then syncs every quarter-hour while any board has never been polled. Polled boards
are ordered by lateness (time since the last poll ÷ cadence period) instead of plain age:
oldest-first starved the daily boards whenever a weekly cohort came due together, and under
a cap it gave every board the same absolute gap. Knobs: `JOBFLOW_SYNC_MAX_BOARDS` (a fixed cap),
`JOBFLOW_SYNC_MINUTES`, `jobflow sync --max-boards N`.

Simulated on the real preset registries (`packages/pipeline/test/sync-budget.test.ts`;
fetch time modelled per ATS: Workday 12 s, Greenhouse 1.5 s, Lever 1 s, Ashby 2 s, others
4 s; 8 at once, ≤2 per host; 21 days):

| Schedule | Registry | First sync | Every board polled after | Max re-poll gap, daily / weekly boards | Longest board phase |
|---|---|---|---|---|---|
| old: 25 boards, oldest first, 2 syncs/day | india (239, 41 daily) | 25 boards | 108 h | **120 h** / 6.5 d | 48 s |
| old: 25 boards, oldest first, 4 syncs/day | india | 25 boards | 54 h | **60 h** / 6.25 d | 48 s |
| web app, every 6 h + catch-up | india | 25 boards, 24 s | 0.3 h | 24 h / 6.25 d | 194 s |
| web app, every 6 h + catch-up | every preset (454, 45 daily) | 25 boards, 22 s | 0.3 h | 24 h / 6.25 d | 262 s |
| worker, every 6 h | every preset | 25 boards | 6.1 h | 24 h / 6.25 d | 262 s |
| `jobflow sync` once a day | india | 25 boards | 24 h | 24 h / 7 d | 210 s |

Live, on a fresh scratch store with the sample persona (india preset, `LLM_PROVIDER=echo`):
the first `jobflow sync` polled 25 of 232 due boards (181 s, most of it registering the 239
seed employers); the second polled all 207 remaining (202 fetched, 5 Workday boards threw
the known adapter error) in 291 s, 0 deferred, 20,376 postings fetched, 9,084 active; the
third, minutes later, found 0 boards due (61 s, feeds only). The old default needed 10
syncs to reach every board.

### Feed: company spread (done)

`diversifyByCompany` (`packages/core/src/match/view.ts`) reorders a ranked list so no company
has more than 3 cards in any 20; the cards it moves down follow later. It is greedy and
stable: nothing is dropped, no score changes, each company's own cards keep their order, and
other companies keep their relative order (invariant #4: an order, not a score or a filter).
`getFeed` applies it by default (`diversify: false` opts out); the CLI (`jobflow feed
--no-diversify`) and MCP `list_jobs` (`diversify`) spread what they actually return, after
`--min-score` and applied-filtering; the web Jobs page re-spreads what its filters show and
has a **score order only** chip (Filters → order). On a ranking like the audit's IN one (Amazon 19
of the top 50) the first 20 cards hold at most 3 Amazon roles by construction; the rest
appear further down at their true scores. Pinned by `packages/core/test/diversify.test.ts`
and `packages/service/test/feed.test.ts`.

### Salary calibration: per market × role family (done)

Cause of the 19% / 21% inversion: non-engineering postings ("other": sales, legal, people,
operations) are priced from loosely related titles (a different title weighs 0.2), and their
many weak comparables saturate the sample-size term, so they sat at confidence ~0.45–0.5
whatever their evidence and missed by ~21%. Engineering estimates at 0.5–0.7 missed by ~15%.
On the IN corpus 1,491 of the 1,961 US-market backtests are "other", 1,132 of them at 0.5.

Fix: `calibrateSalaryScores` (core) keeps the per-market step and adds a role-family step
within each market: a family whose errors exceed what the market's other family achieves at
the same confidence is scaled down by the same expected ÷ actual rule (floored at 0.35,
shrunk toward 1 by n/(n+30), never above 1). Stored per segment (`cal:v2:<market>:<family>`;
the v2 stamp recalibrates on the next poll), named in the basis line ("from 900 backtested
non-engineering US postings"). The estimator's formula is unchanged. A first attempt that
weighted confidence by √fit fixed the IN corpus and broke the US one (22% / 24% / 14% / 15%),
so it was dropped: the calibration step learns the correction per corpus instead.

Leak-free backtest, calibrated, median error by confidence band (`< 0.30 / 0.30–0.50 /
0.50–0.70 / ≥ 0.70`), the same corpora and code apart from the calibration:

| Corpus | Before (per market) | After (market × family) | Segment factors < 1 |
|---|---|---|---|
| IN re-polled (2,313 backtested) | 40% / **19% / 21%** / 10% | 39% / 20% / 15% / 10% | US:other ×0.91, IN:eng ×0.56, IN:other ×0.52, CA:other ×0.56, EU ×0.79, GB:other ×0.89 |
| US re-polled (6,730) | 49% / 23% / 16% / 14% | 44% / 23% / 16% / 14% | EU:other ×0.53, CA:other ×0.6, GB ×0.75–0.81, REMOTE ×0.87 |

Both are monotonic again; overall median error is unchanged (18% / 21%), since calibration
only relabels confidence. `pnpm --filter @jobflow/worker salary` then `salary-backtest` on a
copy of the IN corpus reproduce the IN row (its all-evidence table reads 38% / 24% / 17% / 7%),
and both commands now exit when done (the one-shot worker used to hold the store open). Pinned by `packages/core/test/salary-estimate.test.ts` ("per market ×
role family calibration").

### Single-country remote (designed; built — see the next section)

"Remote - Canada" / "Remote - Brazil" keep `remoteGeo: unknown` plus the country, and the
scorer down-weights a remote role restricted to a foreign country softly, with a flag. A
proper representation is a `country_only` `RemoteGeo` ("remote for residents of
`location.country`"):

- **Storage:** `posting.remote_geo` is plain `text`, so no migration; the Zod enum gains the
  value. Old processes reading a new row would fail to parse it, so the enum should take it
  with `.catch("unknown")` on read.
- **Parser** (`core/normalize/location.ts`): emit `country_only` where it now emits `unknown` +
  a country for a remote-anchored single country (the cases audit finding 5 lists).
- **Scoring** (`core/match/score.ts`): workable when the country is the user's home or one of
  their markets; otherwise the existing soft down-weight and flag. `hardExclude` may treat it
  like `us_only` / `eu_only` only at confidence ≥ 0.85 and only when the user can't live
  there (home and markets), per invariant #4.
- **Views and UI:** the remote-region filter and chips (`FeedView` GEOS, saved-search
  `remote` facet) need a "this country only" entry; `remoteGeoOk` stays region-level, since
  markets already say which countries the user can work from.

Built as designed, with one choice: the parser keeps confidence 0.8 for these (a stated
country, but "Remote - Canada" can also mean a Canada-based team), so the hard rule is wired
but does not fire on parsed rows today; they stay a soft down-weight.

## Follow-ups (2026-11-18, third pass): places, local spellings, agency flag, country-only remote

From `SOURCE_HEALTH.md` "Notes for the core / normalization owners". Measured on one live
scratch corpus (sample persona, presets `india`, `us`, `eu-uk`; the default `jobflow sync`
slice: 25 boards + 12 feeds, 5,435 fetched, 1,959 active), polled into an in-memory store so
every posting kept its location text, then old parser (the base commit's `location.ts`) vs
new on the same rows. Fixtures: `packages/core/test/location-places.test.ts`,
`packages/pipeline/test/location-places.test.ts`, `packages/core/test/agency.test.ts`.

**Multi-place locations.** `ParsedLocation.countries` (ISO-2, primary first; optional, the
primary `country` is unchanged) holds every country a location string names: places split on
`;` `|` ` / ` ` · ` and lower-case " or " / " and " (Greenhouse offices, Workday's joined
locations), never on commas, which qualify a place ("Austin, TX, United States"; "Dublin, OH"
stays US). A segment that names countries keeps all of them ("Remote (US/Canada)", "USA,
Canada, Australia"). `locationInCountry` is `parsedCountryMatches` over every place: `true`
when any office is in the country, `false` only when every office is definitely elsewhere,
`null` for a European office vs a European country (the region rule "Europe" always had). It
backs `isWorkableIn` (preset tags, discovery plausibility, poll ranking), the search view's
place filter, the scorer's home-onsite boost and visa discount, and the impossible-location
rule, which therefore can only get narrower.

| | count |
|---|---|
| postings naming 2+ countries | 81 (53 across 2+ markets, IN / US / CA / Europe…) |
| … by source | Himalayas 55, HN 12, Workday 5, Remotive 5, Wellfound 3 |
| newly workable for a preset market (was not) | us 2, eu-uk 5, canada 2 (none lost) |
| location hard exclusions, old → new, home IN / GB / US / DE | 217→217, 136→136, 79→79, 136→136 (none added, none removed on this slice) |

Most multi-country rows are remote lists (Himalayas' restrictions), whose geo was already
right; the onsite gains are the Greenhouse/Workday offices ("Atlanta; Bengaluru, India",
"Stafford; Glasgow; Oslo", HN's "Berlin, Freiburg, NYC").

**Place names.** European places by country with local spellings (München, Köln,
Deutschland, Österreich, Wien, Zürich, Genève, Bruxelles, Warszawa, Praha, Lisboa,
København, Göteborg…), matched on an ASCII-folded string (`foldPlace`: NFD plus ø æ ß ł đ ı),
and a Unicode-aware city pattern ("München", not "M"). City words shared with common US
places (Cambridge, Birmingham, Hanover, Florence, York…) are left out; an explicit country
name or a US state code wins. `countryCodeFromText` uses the same resolver. On the corpus
168 postings now carry a specific European country (all 33 of `EUROPE_CODES` appear); 2 of
the 97 rows the old parser left without a country gained one ("Karlsruhe", "Den Haag,
Zuid-Holland, Nederland"); the rest are bare "Remote" / "Worldwide" or small towns
(Villeurbanne, Massy, Magdeburg). The `eu-uk` preset polls GB/DE/NL (country-filtered boards
are fetched once per market, so more markets multiply requests), but its tag already takes
any European office through the region rule, so a Copenhagen or München role counts for it.

**Agency flag.** `normalizePosting` sets `postedByAgency` from `looksLikeAgency` (name + JD)
for every source that doesn't flag it itself (Naukri's own answer, a "no" included, wins).
The scorer already applied the same rule at score time, so ranking is unchanged: a trust
discount and a flag, never a filter. 65 of 1,959 were flagged; a spot check of every one found
7 false positives, all in the JD rule: services employers on "value / work / reports for our
clients" and GE Vernova's "erection tools, manpower, working hours". The rule now needs the
recruiter phrasing ("for our client, a…", "who…", "based in…") and an agency word after
"manpower": 58 flagged, the rest intermediaries by name (HiringBlaze, Staffision, Jobskey
Consultancy, HuntingCube Recruitment…), JD ("ClanX is a recruitment partner", "Our client
is…", C2H / corp-to-corp) or Cutshort's own "hiring for a client" field (41 of the 58).

**Country-only remote.** `country_only` as designed above. 3 rows on this corpus ("Remote -
Japan", "REMOTE (Canada)", a Lagos/Cairo/Lahore list), all at confidence 0.8, so 0 hard
exclusions; at ≥ 0.85 the rule would exclude all 3 for each of the four test homes.

**Re-normalizing stored rows.** Location is stored derived and the location text was not
stored, so stored rows can't be re-parsed. `Posting.locationRaw` is now carried from ingest and
`renormalizePostings` (pipeline) re-parses rows that have it and re-reads the agency flag,
idempotently. Persisting `loc_countries` / `location_raw` and the store method it calls
(`updatePostingNormalized`) are a db change (migration 0019, `postgres.ts`, `memory.ts`,
contract test) plus a worker `renormalize` command, kept as a separate patch for the db
owner; until it lands, PGlite/Postgres rows read back without `countries`, so their scoring
uses the primary country as before (in-memory stores keep the field).

Left: comma-separated city lists in one segment ("London, Berlin") still give one country;
`dedup`'s location compatibility and the salary market still read the primary country only.
*Both done in the fourth pass (next section); the db patch landed as migration 0019.*

## Follow-ups (2026-11-18, fourth pass): place lists, named countries, automatic re-normalization

Measured on one live scratch corpus (sample persona, presets `india`, `us`, `eu-uk`, one
default `jobflow sync`: 366 boards + 12 feeds, 22,354 active postings, 14,085 of them with
stored location text — the rest predate `location_raw` and keep their stored location until
their board's next poll). Old parser = the third pass's `location.ts`, new = this one, on the
same rows. Fixtures: `packages/core/test/location-lists.test.ts`,
`packages/pipeline/test/renormalize-version.test.ts`, `packages/adapters/test/cutshort.test.ts`.

| rows with location text (14,085) | old | new |
|---|---|---|
| no country | 584 (4.1%) | 347 (2.5%) |
| confidence < 0.5 | 473 (3.4%) | 210 (1.5%) |
| primary country "Europe" | 2,867 (20.4%) | 61 (0.4%) |
| naming 2+ countries | 683 | 686 |

The 347 left are almost all not places: bare "Remote" / "Global" / "Worldwide" / "North
America" / "APAC" (≈230), "N Locations" and "Multiple Locations" (≈55), "Headquarter", plus
one-off towns (Buc, Zipf, Waukesha) and ambiguous names (Santiago, a bare Birmingham).

- **Comma-only place lists.** Each comma part is classified (country name, state / province /
  region code or name, known city, unknown); a qualifier that follows a place decides its
  country ("Dublin, OH", "London, Ontario", "Perth, Scotland", "Chennai, TN" — Tamil Nadu,
  "Bengaluru, KA"), and a list counts only when 2+ parts resolve to distinct countries
  ("London, Berlin" → GB, DE; "Lagos, Cairo, Lahore" → NG, EG, PK). On this corpus that adds
  few rows (comma lists here are mostly "City, Region, Country"); the first version read
  Indian state codes as countries ("Bengaluru, KA, India" → IN + "KA", 400+ rows) and was
  fixed before it landed, which the table above includes.
- **A real primary country.** A European place reports its country ("München" → Germany);
  the region "Europe" stays only when no European country is named. `parsedCountryMatches`
  keeps the region rule (Germany vs FR is null, as "Europe" was), so nothing built on
  `false` widens; the scorer's location-label match adds "europe" for a European place so
  the eu-uk preset's `europe` preference still matches. The per-place reading also overrides a
  stray whole-string hint ("Durham, United Kingdom" was the US). Older rows keep "Europe"
  until re-normalized; every reader still accepts it.
- **Country words are not cities.** "Remote - Canada", "Remote - India", "United States",
  "UK", a bare state code: `city` null (city-states keep theirs). "India - Hyderabad" now
  takes Hyderabad.
- **Code forms.** Workday's ISO-3 prefixes ("IND BNGL FL2-3", "DEU - Bayern - …"),
  "IND-BLR-…" site codes, "Remote - MA" / "TX - Frisco" (not CA or ME alone: ambiguous),
  every US state code after a comma (minus AR / DE / ID / IN / MT, which are countries too),
  "U.S." with a trailing dot (53 "Remote, U.S." rows went `unknown` → `us_only`), and
  "Home based - …" as remote (31 rows were onsite).
- **More places:** larger German, French, Italian, British, Dutch, Polish, Spanish towns;
  Indian tier-2 cities; Tunisia, Morocco, Mauritius, Kazakhstan, Ecuador and a few more;
  Albania and North Macedonia as European.
- **Dedup** reads every country: {US,GB} vs {GB} compatible (a multi-office posting's one
  stored city is only its first office, so the shared country decides); {IN} vs {US} not; an
  older row's "Europe" pairs with a European country.
- **Salary market.** The estimate is per posting in a shared corpus, not per viewer, so the
  market is the PRIMARY country's. One exception: a posting that STATES its currency is priced
  in the first named country whose market uses that currency (GBP on "New York; London" is a
  London comparable, not a dropped US one); single-country postings and remote roles open
  beyond their countries never move. Backtest on a copy of the corpus, stored (old-parser)
  locations → re-normalized, median error by confidence band (`< 0.30 / 0.30–0.50 / 0.50–0.70
  / ≥ 0.70`): all-evidence 58% / 28% / 20% / 10% → 49% / 29% / 20% / 10%; leak-free 40% / 21% /
  17% / 13% → 37% / 21% / 17% / 12% (5,591 → 5,595 backtested). Monotonic before and after.
  (No calibration rows on this corpus, so calibrated = uncalibrated.)
- **Cutshort** sets `postedByAgency` from its own `hiringForClient` (34 of 100 on a live
  listing page); a "no" falls through to the name/JD rule.
- **Titles:** "SW Engineer", "Software Engineering Intern / Senior Associate" are engineering
  (+40 postings out of "other"). The other engineering-looking "other" titles are solutions,
  sales, support, design, hardware, security and QA roles — correctly outside the archetypes.

**Automatic re-normalization.** `NORMALIZE_VERSION` (core) is recorded per store in
`store_meta` (migration 0020); `pollAll` re-derives stored postings once when the code's
version is newer, before polling, so the CLI's `sync`, the web app's background sync, the
worker and MCP all pick up a parser fix and re-rank as they already do after a sync. A store
recorded by newer code is left alone. `jobflow renormalize` forces a run and prints a summary.
On this corpus (PGlite): 22,354 scanned → 5,334 changed (237 newly placed, 24 now
multi-country, agency +5), 21 s including the re-rank.

Left: stored rows that predate `location_raw` (8,269 here) re-parse only when their board is
polled again; `renormalize` does not re-derive titles (a re-poll does); the stored `dedup_key`
is not refreshed by a re-normalize (dedup recomputes keys, the don't-double-apply guard reads
the stored one); "Toronto, ON, Canada, New York, NY" keeps the US as primary (US hints outrank
Canada's), with both countries listed.


## Feed review (2026-11-18, fourth pass): would a job seeker trust the top 50?

Four fictional personas, each a throwaway PGlite store synced twice with its presets: the
sample persona (India, Java backend, 3 yrs; `india`, 9,381 postings), a senior frontend
developer in Germany wanting EU remote (`eu-uk,global-remote`, 5,497), a new-grad data analyst
in the US (`us`, 5,965) and a Canadian backend developer open to US remote
(`canada,global-remote`, 3,110). The top 50 of `jobflow feed --json` and ~10 `jobflow show`
per persona were read by hand and counted with a script (not committed); "after" is a
`jobflow rank` of the same stores with the fixed code. Regression tests:
`packages/core/test/card-copy.test.ts`, `packages/service/test/feed-cards.test.ts`,
`packages/adapters/test/text-cleanup.test.ts`.

| In the top 50 (IN / DE-FE / US-DA / CA-BE) | before | after |
|---|---|---|
| broken location line (empty for remote, "Canada, Canada", "Poland, Europe", "GURGAON") | 10 / 13 / 7 / 22 | 0 / 0 / 0 / 0 |
| fit note names the wrong main language | 5 / 6 / 1 / 4 | 0 / 1 / 0 / 0 |
| card notes with jargon ("direct match", "~1-2wk ramp", `distributed_systems`) | 50 / 49 / 45 / 44 | 0 / 0 / 0 / 0 |
| "JD requires x (you don't list it — stretch)" flags | 10 / 6 / 10 / 9 | 0 / 0 / 0 / 0 |
| open > 90 days | 1 / 14 / 10 / 8 | 0 / 2 / 4 / 0 |
| far-off role type (data/ML/SRE/mobile for a frontend dev; SWE for an analyst) | 1 / 7 / 34 / 0 | 0 / 2 / 20 / 0 |
| data/analytics-titled roles for the analyst | 0 | 7 |
| intermediaries flagged (agency, freelance marketplace) | 1 / 0 / 0 / 0 | 1 / 2 / 0 / 0 |
| company legal-form noise ("Pvt. Ltd.", ", Inc.") | 2 / 1 / 0 / 0 | 0 / 0 / 0 / 0 |

Root causes and fixes (match, service card, adapters, CLI/web/MCP card text):

- **Location line**: three surfaces each built their own from `city` + the legacy `country`
  ("Europe" for most of Europe; remote roles had an empty label). `describeLocation`
  (`core/match/display.ts`) builds one line from `countries`, used by the card DTO, the CLI, the
  web and MCP.
- **Main language**: `jdSkills` come in dictionary order, so `jdLangs[0]` named Java on Go and
  Kotlin roles. `primaryLanguage` reads the title, then the most-mentioned language in the JD.
- **Role-type fit** was one flat 0.65 for any non-target engineering role; it is now a
  directional table per target. "Data Analyst" / "Analytics Engineer" titles are filed under
  `other` by the title normalizer (76 of 82 analyst titles on the US corpus); for a data target
  the scorer reads them as data roles (normalizer fix still wanted, see below).
- **Stale reqs**: freshness weighs 0.08, so a 300-day req sat among this week's; a soft
  ×0.95/0.9/0.85 past 60/120/180 days.
- **Company spread** deferred a company's 4th role below everything; it now comes back once the
  next card would score more than 12 points less, with "+N more at … further down".
- **Markup**: Greenhouse sends entity-escaped HTML, which `htmlToText` unescaped after stripping
  tags; numeric entities were never decoded. On the IN corpus 4,155 of 9,381 JDs carried markup
  or entities (166 after, all truncation artefacts of the dump; a live GitLab board: 0), 1,294
  hid "N+ years" and 234 hid C++. Stored rows clean up on their next poll.

Left for other owners: see the report of this pass (title normalizer, skills dictionary,
salary display, presets tags, same role posted per country).


## Taxonomy pass (2026-11-18): titles, skills, levels, cross-country siblings

The feed review's "left for other owners" list, measured on the same four persona stores
(copies; IN Java backend p0 9,381 postings, DE frontend p1 5,497, US new-grad analyst p2
5,965, CA backend p3 3,110). Corpus numbers compare the parser before this pass (HEAD) with
this one on the same stored rows; feed numbers compare the feed review's final top 50 with a
`jobflow renormalize` + `feed --limit 50` of a copy. Fixtures: `packages/core/test/taxonomy.test.ts`,
`packages/pipeline/test/renormalize-taxonomy.test.ts`, the sibling cases in
`packages/service/test/feed-cards.test.ts`, the patch case in `packages/db/test/contract.test.ts`.

| corpus (IN / DE / US / CA) | before | after |
|---|---|---|
| analyst / BI / analytics-engineering titles filed `other` | 74 of 80 / 66 of 67 / 35 of 35 / 30 of 31 | 0 / 1 / 0 / 1 |
| data-titled roles (the feed review's regex) filed `other` | 104 / 83 / 60 / 40 | 5 / 5 / 5 / 2 |
| all titles filed `other` | 6,974 / 4,474 / 4,695 / 2,363 | 6,836 / 4,385 / 4,622 / 2,324 |
| iOS / Swift titles whose JD named no language we know | 9 of 14 / 16 of 17 / 11 of 12 / 6 of 8 | 2 / 1 / 2 / 0 |
| postings with no recognised skill | 3,809 / 2,459 / 2,461 / 1,078 | 3,310 / 2,222 / 2,144 / 936 |
| city a fragment of a multi-word name ("San", "United", "New") | 1 / 8 / 43 / 29 (stored) | 0 / 0 / 0 / 0 (one "North", one "St" fixed after) |
| remote `eu_only` naming a non-European country (US corpus) | 12 | 1 (it names EMEA) |
| sibling groups (same role, other countries) / cards they save | — | 196 / 277 · 331 / 485 · 310 / 462 · 235 / 280 |

| top 50 (IN / DE / US / CA) | before | after |
|---|---|---|
| a domain ("fintech") listed as missing | 3 / 5 / 7 / 0 | 0 / 0 / 0 / 0 |
| `#india` on a role not workable in India | 0 / 2 / 15 / 9 | 0 / 0 / 0 / 0 |
| same company + title shown twice | 2 / 0 / 0 / 2 | 1\* / 0 / 0 / 0 |
| cards carrying "Also posted for …" (folded) | — | 0 / 1 (1) / 2 (2) / 6 (6) |
| US analyst: data / analytics-titled roles, `other` cards | 16, 5 | 17, 0 (persona targets `data_ml`, read as both) |
| same analyst with `--roles data_analytics` | — | 26 data-titled, 5 SWE (was 18) |

\* GE HealthCare's two Bengaluru "Software Engineer" reqs (hybrid / onsite, one place): separate
headcount, correctly not siblings. An American Express pair was a duplicate whose match row
from before the re-dedup was still listed — `listMatches` now lists canonical postings only. Résumé import of the fictional personas (`feedqa/resumes`): analyst 1
skill → 9 (SQL, Python, pandas, Excel, Tableau, Power BI, R, statistics, A/B testing), frontend
4 → 12 ("Next.js" / "Vue.js" were read as JavaScript; Vue, CSS, HTML, Jest, Playwright,
webpack, Storybook were unknown), backend 13 (unchanged). Every one is a span in the file.

- **Role types.** `data_analytics` (enum value appended; stored values keep their meaning) for
  analyst / BI / analytics-engineering heads, read before the non-engineering guard. The guard
  now lets the role NOUN win: assistant, administrator (not sysadmin / DBA), support, success,
  coordinator. The scorer's "Data Analyst filed as other" fallback became one source of
  truth: a stored `other` row is re-read with `parseTitle`. A `data_ml`-only target reads as
  both data types (`effectiveTargets`). Analytics roles are far from software engineering both
  ways, with a flag saying which. The software-engineer title family (salary comparables)
  applies to engineering role types only.
- **Levels.** Rungs after any role noun, V / 5, L8+, Meta E-levels and IC / ICT codes beside a
  role noun or as a tag, the MTS ladder; a bare "Member of Technical Staff" has no level (53
  rows on the US corpus read "staff"). `levelConfidence`: a company code (< 0.6) yields to the
  source's own level bucket. The level-null share of engineering titles barely moves (31 new
  bands, 53 MTS bands removed on the US corpus) — most titles carry no level at all; the JD's
  years decide those.
- **Skills.** 30 dictionary entries; ambiguous names only in cased / contextual form; Snowflake
  left out (named as a customer in boilerplate on three boards), "statistics" only as a skill or
  a field of study ("frequently cited statistics show…" is diversity boilerplate on 50 Tailscale
  JDs). A skills-list token takes the alias covering most of it. Declared skills canonicalize
  before scoring, so a profile saved with "power bi" matches `power_bi`.
- **Siblings** (`core/dedup/siblings.ts`): company + dedup title key (level kept) with place /
  work-mode segments dropped ("… | Spain | Remote", "(Remote, Canada)"), word-set JD overlap ≥ 0.7,
  a different place. The service folds each group under its best-scoring member after the view
  and before the page cut (fetching 3× the page so a folded sibling doesn't take a slot).
- **Re-normalize v3.** Cleans stored JD markup / entities (`cleanStoredJd`, moved with
  `htmlToText` / `cleanTitle` to `core/normalize/markup.ts`), decodes title entities, re-derives
  title family / role type / level / skills / requirements / years and the dedup key (the
  "left" item of the fourth pass). On the persona copies: 4,936 / 4,933 / 7,689 / 2,571 rows
  changed (US / DE / IN / CA), 3,439 / 2,254 / 4,358 / 1,514 JDs cleaned. Level and years a
  source states aren't stored apart from parsed ones, so for the sources that send them a
  stored value is kept unless the title / JD now states one with confidence.

Left: the iOS roles that still name no language have no Swift / Objective-C in their stored
JD (lite listings); "Data Analyst" titles outside the regexes ("Senior Analyst, Frontline
Performance") stay `other`; the analyst persona's top 50 still holds AI-engineer roles because
`data_ml` mixes data science with ML engineering — a split of that value was not attempted;
the salary pipeline's ENG archetype sets (owned by the salary pass) don't include
`data_analytics` yet, so analyst roles are priced like `other` as before.

## Salary units, periods and currencies (2026-11-18)

Ask: read pay with its units (per year / month / week / day / hour, LPA / lakh / crore / CTC,
k / M), its currency (incl. an ambiguous "$", "kr", "¥"), base vs OTE vs total comp and equity;
compare in one currency via FX; show the posting's own figure plus a converted one.

What changed:
- **Parse** (`core/normalize/salary.ts`): the stated `period`, `basis` and `equity` are kept on
  `posting.salary` (min/max stay annual; migration 0021). A bare "$" follows the posting's
  country — CA$/A$/NZ$/S$/HK$/MX$, a US (or US-only remote, or US-office) posting's is USD, and
  anywhere else (or unknown) it is read as USD at `medium_high`, which the hard floor never
  acts on. "kr" needs SE/NO/DK/IS, "¥" CN/JP. A figure too small to be a year with no period
  written is read as monthly at `medium_high`. Variable-pay labels ("Target Variable range",
  commission, bonus) and equity grants ("INR 30-50L in stock") are never salary; with a base
  and an OTE band, base wins and the two are never unioned. `SALARY_PARSE_VERSION` re-parses a
  store once on its next sync.
- **FX** (`core/salary/fx.ts`, `pipeline/src/fx.ts`): ECB table dated 2026-11-18 (+ AED/SAR
  pegs); syncs refresh it from api.frankfurter.dev (keyless) and cache it in `store_meta`.
- **Comparisons** (`core/salary/compare.ts`): floor, `--min-salary`, score, `--sort pay` in one
  currency. Converted: one confidence step lower for soft uses; a hard decision only when
  still below after the rate's uncertainty (3% + 1%/month of age). Hourly/daily/weekly rates
  never decide alone.
- **Display** (`core/salary/format.ts`): one formatter for web, CLI and MCP. Estimates under
  0.4 confidence (or wider than ×2.2) show one rough figure; equal ends print once; a stated
  currency that disagrees with the location is flagged (feed review items 1–3).

QA corpus (sample persona, `india` preset, two syncs: 9,469 active postings, 336 with a source
salary field). Old code + old `salary` vs new `salary`:

| | before | after |
|---|---|---|
| postings with stated pay | 884 | 898 (+14: ₹ monthly intern stipends, PHP) |
| currencies seen | 8 | 10 (+PHP, MXN) |
| period recorded | none (everything annualised silently) | 416 explicit: 381 year, 10 month (1.1%), 22 hour (2.4%), 3 week; 482 unchanged rows read as year |
| basis / equity | — | base 224, OTE 89, total 11; equity on top 41 |
| confidence high / medium_high / medium | 804 / 78 / 2 | 793 / 103 / 2 |

Of the 804 old `high` bands, 18 dropped to `medium_high` — every one a bare "$" on a posting
not placed in the US (India offices, Wellfound "$35k – $40k" for India-remote, unplaced
onsite roles): exactly the conversions that must not hard-exclude. 9 bands changed figures,
all corrections (OTE or variable pay had been unioned into the base band: "$94.4k–$298.7k" →
"$94.4k–$149.4k"; an equity grant had widened "15-25 LPA" to ₹15L–50L). One Canada-only remote
"$55 - $75" is now CAD per hour.

`salary-backtest`, median error by confidence band (`< 0.30 / 0.30–0.50 / 0.50–0.70 / ≥ 0.70`):

| | before | after |
|---|---|---|
| all-evidence | 50% / 23% / 20% / 12% (n 738) | 46% / 23% / 20% / 12% (n 762) |
| leak-free, calibrated | 45% / 24% / 19% / — (n 738) | 44% / 25% / 18% / — (n 762) |

Monotonic in both. Left: the 482 untouched rows carry no explicit `period` until their board's
next poll (absent = year by contract); an unplaced remote "$" band is no longer hard-excluded
(by design).
