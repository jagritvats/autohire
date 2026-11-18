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
The adapter does not enforce that, so whatever schedules it (a preset or a saved search)
must poll no more often.
