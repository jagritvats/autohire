# Source health audit (2026-11-18)

A live check of every cloud adapter in `ADAPTERS` and the ATS detector, run before and
after the fixes in the same branch. The script was a scratch file, not committed. It
fetched one representative target per row with at most 4 requests in flight and at most 2
per host, using each adapter's own timeouts.

Columns:

- **n**: postings the adapter returned. **P** means the result was marked partial
  (`markPartial`), so ingest skips `markStale` for that poll.
- **dup**: repeated `atsJobId`s within one fetch.
- **field %**: share of rows with a title, company, location, a parseable `postedAt`, an
  http(s) `applyUrl`, and a JD of at least 200 characters.
- Boards that need a detail call per posting (SmartRecruiters, Workday, Eightfold, Oracle,
  Rippling, Zoho, TalentBrew, BambooHR, Breezy) ran with `limit: 8`, which caps the detail
  calls at 8. Their **JD** and sometimes **date** columns therefore show the audit cap, not
  a defect. `pickForDetail` also skips clearly non-engineering titles on purpose.

## Sandbox caveats: what this run could not verify

Results from this sandbox's network are not always what a user's machine or a cloud worker
would see.

- **Node's direct egress** answered `403 Blocked by egress policy` for
  `tjapi.timesjobs.com` and `www.reddit.com`. Through the agent proxy
  (`NODE_USE_ENV_PROXY=1`), TimesJobs works: 60 postings, every field present.
- **Reddit** (`reddit`, r/developersIndia): **unverified here.** Through the proxy, every
  RSS URL, including the subreddit's front page, answers `404` with an empty "Not Found"
  Atom feed. JSON answers `403`. Reddit refuses this egress IP, so the adapter's parsers are
  covered only by their fixture tests.
- **Shared-IP rate limits** came and went during the runs. They were not adapter bugs:
  - Workable's Cloudflare returned `429` with `error code: 1015` and `Retry-After: 84036`
    (about 23 hours) for a while.
  - Workday and Wellfound returned `429` through the proxy route in the second run, and
    answered normally over direct egress a few minutes later.

  The tables use the run in which each host answered.
- **The `rss` and `json_feed` adapters** fetch through `safeFetchText` (the Node `https`
  module, not `fetch`), so the request columns don't count their calls. Both returned rows.
- **Key-gated sources** (`adzuna`, `careerjet`, `jsearch`) were checked with no keys set.
  Each returned `[]` and made **0 requests**, as designed. With keys, they are unverified
  here.

## ATS boards

| Adapter · target | before: n / dup / notes | after: n / dup / notes |
|---|---|---|
| greenhouse · stripe, vercel, highradius | 789 / 87 / 68, 0 dup, all fields 100% | same |
| ashby · ramp, Linear, plaid | 181 / 33 / 142, all fields 100% | same |
| lever · matchgroup, palantir, hevodata | 68 / 200 / 40, all fields 100% | same |
| smartrecruiters · PHONEPELIMITED, Freshworks, ixigo | 154 / 25 / 9 | 155 / 25 / 9 (a list cut at 600 is now partial) |
| workday · nvidia, salesforce, adobe | 239 / 102 / 37 | 239 / 102 / 37 |
| **eightfold · Microsoft** | **0** (429 on page 5; the single retry gave up and the whole list was lost) | **199 P** (backs off on 429) |
| eightfold · Qualcomm | 200, **4 dup**, not partial | 194 P, 0 dup |
| eightfold · Vodafone | 200, not partial (board larger than the 200 cap) | 200 P |
| eightfold · HSBC (v2) | 194, 1 dup | 195, 0 dup |
| oracle · JPMC, Goldman (hdpc), iaaviz | 290 / 110 / 19 | 293 / 110 / 19 (dedupe; a list cut at 1000 is partial) |
| **amazon** | **500, not partial** (a 500-row window of about 1.1k) | **500 P** |
| atlassian | 24 (postedAt 0% by design: no publish date) | same |
| jobvite · nutanix | 56, all fields 100% | same |
| rippling · rippling, copado, rsa-security | 101 / 7 / 10 (date comes from detail) | same |
| **workable · minderacraft** | **76 rows, 40 dup, location 29%** | **36 jobs, 0 dup, location 100%** |
| workable · huggingface | (429) | 6, all fields 100% |
| jibe · pepsicojobs, keysight | 206 / 66 | same (a list cut at 1000 is now partial) |
| talentbrew · UnitedHealth Group, Intuit | 218 / 30 | same (a list cut at 1000 is now partial) |
| kula · cashfree, slice, acko | 32 / 36 / 24 | same |
| keka · signzy, eloelo, jupiter | 16 / 29 / 5 | same |
| zoho · wissen | 42 | same |
| freshteam · everstage, locus | 6 / **0** (Locus's widget answers `{"jobs":[]}`: the board is empty, not broken) | same |

## New ATS pollers (after)

| Adapter · target | n | Notes |
|---|---|---|
| recruitee · bunq, channable | 22 / 10 | every field 100%; `isLive` live-checked: listed id → true, bogus id → false |
| personio · 1komma5grad, tado | 325 / 2 | JD 99%. The first build used `?language=en`, which blanked 288 of 325 JDs, so the feed is now read without it. `isLive` live-checked. |
| teamtailor · lunar, doktor, jobs.lunar.app (custom domain) | 19 / 46 / 19 | every field 98–100%; `isLive` live-checked |
| bamboohr · kiln, canopy | 10 / 3 | date and JD come from the detail call (capped at 8 in the audit; non-engineering titles skipped); `isLive` live-checked |
| breezy · ardent, landmark | 8 / 2 | JD comes from the job page's JSON-LD; `isLive` live-checked (a gone position redirects to the portal root) |

## Aggregators and feeds

| Adapter · target | before | after |
|---|---|---|
| himalayas · backend/IN, swe/GB | 60 / 40, all 100% | same |
| remotive · backend | 16 (Remotive's whole match for "backend" in software-dev) | same |
| arbeitnow · engineer | 60, location 83% (the source leaves it empty) | 60 (a query now walks up to 3 pages; empty location is null, not "") |
| hn_whoishiring · backend | 49, location 94%, applyUrl 88% (some posts have no link) | same |
| hirist · backend | 60, **5 dup**, JD 23% (by design: built from tags) | 60, 0 dup |
| cutshort · backend-blr | 50, all 100% | same |
| timesjobs · backend | 0 (egress block, sandbox only) | 60, all 100% (via proxy) |
| instahyre · years=2 | 15, all 100% | 15 (one 429/403 on a detail page) |
| wellfound · backend/india | 70, all 100% | 70 |
| reddit · developersIndia | 0, **unverified here** | 0, **unverified here** |
| rss · We Work Remotely back-end | 8 | 8 |
| json_feed · Remotive API | 16 | 16 |
| adzuna / careerjet / jsearch (no keys) | 0 rows, 0 requests | same |
| **remoteok** (new) · all, tag=python | — | 97 / 100, all 100% |
| **jobicy** (new) · engineering, eng/europe | — | 100 / 50, all 100%; `isLive` live-checked: listed → true, unknown id → null |
| telegram (helper) · gocareers, techuprise_updates | 20 msgs / 85 links, 20 / 168 | same |

## Detector (33 inputs)

| | before | after |
|---|---|---|
| Careers URLs on known ATS hosts (17) | 12 confirmed, personio guessed (no probe), and 4 **unknown**: teamtailor, bamboohr, breezy, a custom-domain Teamtailor site | 17 of 17 confirmed when the host answered (Workday and Workable showed "guessed" only while they returned 429) |
| Company names (12) | 11 as expected, plus `Ramp` → greenhouse/ramp | unchanged |
| Careers pages (3) | figma.com → greenhouse, notion.com → ashby, stripe.com/jobs → none | unchanged |
| Nonsense name | none | none |

Known limits, not fixed:

- **Name-only probing can hit a namesake board.** Greenhouse `ramp` exists and has jobs,
  but the fintech Ramp is on Ashby. That is why seeds carry explicit careers URLs and
  presets keep a name-only guess only when `detectChecked` passes.
- **stripe.com/jobs links no ATS.** Stripe hosts its own page, so URL-only detection finds
  nothing there.

## Bot-walled or login-only (Tier 3, not built in the cloud)

Nothing new was found that needs a login. Darwinbox, Naukri, LinkedIn, Glassdoor,
AmbitionBox and Peerlist stay local-agent only. Remote OK and Jobicy were checked against
their published API terms before being built. Both require a link back, so each one's
`applyUrl` is its own listing URL. Jobicy also asks for at most one automated pass an hour.
Since the follow-up below, the adapter enforces that itself.

## Follow-up fixes (2026-11-18, later the same day)

Fixes for the adapter TODOs this audit and `PRESET_COVERAGE.md` found, re-checked live with
the same politeness (at most 4 requests in flight, 2 per host, the adapters' own timeouts).
Each has a fixture regression test in `packages/adapters/test/followups.test.ts`.

| Item | Found | Change | Live before → after |
|---|---|---|---|
| **Workday redacted rows** | Some tenants list rows with only `bulletFields` (`{"bulletFields":["R-293658"]}`): no title, no `externalPath`. `idOf` threw and the whole board returned nothing. They come and go between runs (this run: Mastercard 1–3, PwC 3, HPE 1, Citi 1; Barclays, Deutsche Bank, State Street none). | Skip them. The completeness check still counts every row received against the board's `total` (which counts redacted rows), so a skipped row can't make a short list look complete. A complete list minus its redacted rows is still diffed (`markStale`): a redacted row's id never appears as a normal row and the row can't be opened, so the only posting a diff could retire is one the board no longer shows. If a redacted row's bullet id matches a stored posting (`known`, allowing Workday's `-2` repost suffix), the fetch is marked partial instead. `fetch` is now total: an unexpected answer is logged and returns `[]`. | India lists: Mastercard 0 → 173, PwC 0 → 161 (P: no country facet, unfiltered fallback), HPE 0 → 347, Citi 0 → 399 (P: 400 cap). Harman's `HARMAN` site now answers `total: 0` (empty site, not an adapter fault). |
| **Eightfold v2 (Bayer)** | The "config object" is v2's normal reply: the whole page config with `positions` and `count` inside. For Bayer `positions` is `[]` and `count` is `0` for every location and host (`talent.bayer.com`, `bayer.eightfold.ai`), and Bayer's own careers page renders the same 0. PCSX answers 403 "not enabled"; a Workday `bayer` tenant answers 422 for every site name tried. | No endpoint yields positions: the board is empty. A v2 reply with no `positions` list at all now logs a reason (`[eightfold] <domain>: /api/apply/v2 answered without a positions list…`). Bayer is dropped from the india seeds. | 0 → 0 (empty board) |
| **Eightfold Qualcomm / Microsoft** | The discovery audit saw 0 for both. | Re-checked after the 429 backoff: no change needed. | Qualcomm 199 P (25 s), Microsoft 198 P (140 s, backing off on 429s) |
| **Greenhouse work modes** | Cloudflare puts "Hybrid", "In-Office", "Distributed" (or a mix) in `location.name` for 476 of 483 roles. The board API already returns `offices[]` with `?content=true`, each with a short `name` and a full `location` ("Austin, TX, United States"). | When `location.name` is only work-mode words, the location becomes the offices, prefixed with the mode ("Hybrid - Austin, TX; London, United Kingdom"; Distributed alone → "Remote - …"; a mix with Hybrid → "Hybrid"). A bare "Remote" is left alone (its office is often just HQ). | Cloudflare roles workable in US 0 → 278 (139 eng), GB/DE/NL 1 → 88 (42), CA 0 → 35 (14), IN 0 → 17 (8) |
| **Himalayas 429** | Keyless callers share one public allowance; from shared egress it answers 429 "get a free API key". Their docs (checked 2026-11-18): optional key as `Authorization: Bearer`, 60/min and 10,000/day per account; a keyed 429 carries `Retry-After`. | Optional `HIMALAYAS_API_KEY`; pages fetched with `httpJsonPolite` (2 retries, 5 s → 10 s, or `Retry-After`). A keyless 429 that outlasts the backoff logs once and parks the source for 15 min (so the other targets don't each wait it out), and the feed returns `[]`. | This run answered 200 without a key: 4 targets, 8 requests, 40 rows each (US 40/40 in market, GB 39/40, CA 35/40). The 429 path is covered by fixtures. |
| **Workable "36 vs 76"** | The 76 widget rows are one row per city: the earlier audit counted 40 duplicate rows. | None: the adapter's 36 is the de-duplicated count, folded with every city (`parseWorkableJobs`). No roles are missed. | Live: 76 widget rows = 36 unique shortcodes; the adapter returns all 36, including all 9 jobs with an India city (13 India rows) |
| **Jobicy hourly limit** | The terms ask for one automated pass an hour; nothing enforced it. | The adapter keeps a per-process "last pass" per target and returns `[]` without a request inside the hour. Preset Jobicy feeds are `slow`. | 6 targets, 6 requests: engineering 100, usa 97 (95 in US), canada 32 (22 in CA), uk 66 (65 in GB), germany 46 (45 in DE), anywhere 6 |
| **HN job seekers** | "Who wants to be hired"-style self-posts ranked #1–2 for the India profile. | Skipped: a lede like "SEEKING FREELANCE" / "Looking for work", or an "I'm a software engineer…" introduction, with none of the employer's voice ("we're", "our team", "hiring"…). | Current thread: 231 → 229; the 2 dropped are exactly the seekers. "SEEKING FREELANCER … We're looking for…" (an employer) is kept. |

### isLive for Ashby, Hirist, Wellfound, Himalayas

| Source | Per-job check | Decision |
|---|---|---|
| Ashby | `jobs.ashbyhq.com/{board}/{id}`: listed id → 200, unknown id → 404. The posting API has no public per-job route (401). | **Added** (the hosted page). |
| Himalayas | Documented: `himalayas.app/jobs/api/companies/{co}/jobs/{slug}` → 200 open, 410 closed, 404 none. Live: listed → 200, unknown → 404. | **Added** (with the key when set). |
| Hirist | `www.hirist.tech/j/{id}` answers 200 for any id (a client-rendered page); `gladiator.hirist.tech/job/{id}` is not an endpoint (404 "Endpoint not found" for every id). | Not added: nothing says "gone" definitively. |
| Wellfound | A job it was listing at that moment answered **410**; an unknown id 404. | Not added: a 410 on a live role would retire it. |

### Notes for the core / normalization owners

- `parseLocation` keeps one country for a multi-place string: "Hybrid - Austin, TX; London,
  United Kingdom" is US only, so a Cloudflare role in Austin and London doesn't count for
  eu-uk. Workday's joined locations have the same limit.
- Not recognised as countries/places: Copenhagen/Denmark, Oslo/Norway, Helsinki/Finland,
  Vienna/Austria, and German spellings (München, Köln, "Deutschland"). ottonova's 9 roles in
  "München; Köln" count nowhere.
- `postedByAgency` is only set by Naukri. `looksLikeAgency()` (core `match/trust.ts`) is now
  exported, so normalization could set the field for every source.
