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
new market mix.

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
  rather than a fixed 25.
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
  (the pipeline passes it with a cast to clear a stale pointer).
- **service / CLI**: scale the default sync's `maxBoards` with the registry; consider a
  per-company interleave in the feed.
