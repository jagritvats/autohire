# Preset coverage audit (2026-11-18)

A live audit of every built-in discovery preset's seed employers, the fixes and additions
it led to, and what's left for the adapters. The seed lists live in
`packages/pipeline/src/presets/companies.ts` (us / eu-uk / global-remote / canada) and
`packages/pipeline/src/seed.ts` + `seeds-employers.ts` + `seeds-local.ts` (india).

## Method

For every seed, the audit script:

1. ran the real ATS detector (`detect({ url, name })` from `@jobflow/adapters`): URL pattern,
   then careers-page sniff, then the name-slug probe;
2. listed the resolved board through the real adapter (`atsAdapter(ats).fetch`) with no
   detail calls. Country-aware boards (Workday, SmartRecruiters, Eightfold, Oracle, Jibe,
   TalentBrew, Amazon…) were fetched once per preset market;
3. counted the roles **in the preset's markets** with the pipeline's own test,
   `isWorkableIn(parseLocation(locationRaw), markets)`. For `global-remote`, which has no
   markets, it counted remote roles open worldwide or with no stated region (the same test
   `presetsForPosting` uses). It also counted the engineering titles among them and those
   posted in the last 120 days;
4. checked the company: the share of job descriptions that name it (this caught the Ashby
   `cursor` board, whose postings are now another company's), plus a look at locations;
5. re-probed any board that came back empty and recorded the HTTP status, so a dead board
   (404/422/403), an adapter failure (200 but no rows) and a sandbox egress block
   (`403 Blocked by egress policy`) are told apart.

The script ran politely: at most 4 boards in flight and 2 per host. Over the session the
sandbox egress proxy blocked nothing by policy. `$HTTPS_PROXY/__agentproxy/status` recorded
one relay failure, a 502 CONNECT to `nxp.eightfold.ai`: a guessed host that doesn't exist,
not a block.
The rate limits that did show up came from the boards themselves: Workable once (429),
Eightfold (Microsoft, 429 after about 12 pages) and Himalayas (429, "get a free API key").

Candidate employers were first found with cheap slug probes (Greenhouse / Ashby / Lever /
Workable / SmartRecruiters / Workday CXS). Only boards that then passed the full audit with
at least one in-market role went in. Nothing was added on name alone.

## Before → after

| Preset | Seeds before | with board URL | with in-market roles | Seeds after | with board URL | with in-market roles | in-market roles (eng) after |
|---|---|---|---|---|---|---|---|
| `india` | 230 | 227 | 202 (88%)¹ | 239 | 236 | 224 (94%)¹ | 15,609 (7,110) |
| `us` | 47 | 36 | 44 (94%) | 130 | 130 | 129 (99%)² | 20,740 (8,805) |
| `eu-uk` | 27 | 14 | 23 (85%) | 99 | 99 | 99 (100%) | 6,523 (1,787) |
| `global-remote` | 24 | 14 | 14 (58%) | 31 | 31 | 31 (100%) | 421 (191) |
| `canada` (new) | — | — | — | 42 | 42 | 42 (100%) | 2,027 (816) |

¹ The remaining India misses are not dead boards. 4 are Darwinbox boards only the local
agent can read, 3 (Zerodha, Setu, Juspay) have no pollable ATS, and 8 are live boards the
**adapters** fail on (see "Adapter TODOs"). ² Cloudflare: its board is live, but the
Greenhouse board gives work modes ("Hybrid", "In-Office") where the city should be.

**Resolution rate.** Before, 83% of non-India seeds (81 of 98) resolved to a board with
in-market roles. Before the audit, 34 non-India seeds were name-only. 26 of those resolved
by slug probe. Of those 26, 3 were wrong or empty: Webflow resolved to an empty Greenhouse
shell, Miro to a board with no European roles, and Deel to an empty Ashby board. 8 found
nothing. After the audit, every non-India seed carries a board URL, and 301 of 302 have
in-market roles.

## Removed

| Preset | Company | Why |
|---|---|---|
| india | NXP | Workday tenant answers 422 for every site name (moved off Workday; new board not found) |
| india | LiveRamp | Workday site answers 403 "permission denied" |
| india | Locus | Freshteam board empty |
| india | Fi Money | Lever `epifi` board empty |
| india | Ramp, Plaid, Linear, Match Group, Palantir | 0 India-workable roles (kept in us / eu-uk / global-remote) |
| us | Retool | no public Greenhouse / Lever / Ashby board |
| eu-uk | Klarna, Personio | no board on a pollable ATS (see TODOs: Teamtailor / Personio) |
| eu-uk | Miro | Ashby board has no European roles left (Austin / Tokyo / Sydney) |
| global-remote | Automattic, Doist, Hotjar | own careers sites / no pollable board |
| global-remote | Deel | Ashby board empty |
| global-remote | MongoDB, Okta, Reddit, Mattermost, Cloudflare | no roles open worldwide (they stay in us / eu-uk) |
| global-remote | Canonical, Notion | moved: Canonical's "Home based – EMEA" roles count for eu-uk (152), not worldwide. Notion had no worldwide engineering roles, so it stays in us only |

## Updated

- **Webflow**: Greenhouse (empty) → Ashby `webflow`.
- **Checkout.com**: name-only (unresolved) → Ashby `checkout.com`.
- **Sourcegraph**: name-only (unresolved) → Greenhouse `sourcegraph91`.
- Every remaining name-only non-India seed got its verified board URL (Monzo, GoCardless,
  Intercom, Deliveroo, Contentful, Celonis, N26, Adyen, Mollie, Brex, Gusto, Affirm, Asana,
  Airtable, Samsara, Duolingo, Scale AI, Vanta, Grafana Labs, PostHog, Zapier).

## Added (all verified 2026-11-18 with in-market roles)

- **india (+18)**: eBay, S&P Global, Marvell, Gartner, Fidelity Investments, Red Hat, Zoom
  (Workday); Fivetran, Bitwarden, Elastic, IMC Trading, Commvault, Coursera, LaunchDarkly
  (Greenhouse); JumpCloud, Outreach (Lever); Ema, Composio (Ashby).
- **us (+84)**:
  - fintech and crypto: Block, Chime, Mercury, SoFi, Upstart, Wealthfront, Carta, Gemini,
    Kraken, Alchemy, Uniswap Labs, Phantom
  - AI: Perplexity, Harvey, Cohere, ElevenLabs, Deepgram, LangChain, Modal, Replit
  - infra, data and devtools: Elastic, Cockroach Labs, ClickHouse, Temporal, Fivetran,
    Airbyte, Astronomer, Hex, Metabase, Render, Docker, Sentry, LaunchDarkly, PagerDuty,
    Honeycomb, Tailscale, Coder, Warp, 1Password, Snyk, Tanium, Mozilla
  - product: Benchling, Checkr, Mixpanel, Attio, incident.io, Outreach, Squarespace, Faire,
    DoorDash, Flexport, Nextdoor, Thumbtack, Ro, Roblox, Twitch, Riot Games, Epic Games
  - autonomy, hardware and defense: Waymo, Zoox, Nuro, Verkada, Anduril, SpaceX
  - big employers: Netflix and Qualcomm (Eightfold); JPMorgan Chase (Oracle); Cisco,
    Intel, Visa, CrowdStrike, Broadcom, Workday, Micron, Marvell, Red Hat, Zoom, Zillow,
    eBay, Capital One, Fidelity, Target and Walmart Global Tech (Workday)
- **eu-uk (+75)**:
  - UK: Zopa, Form3, Paddle, Multiverse, Synthesia, Wayve, PolyAI, ElevenLabs, Granola,
    incident.io, Attio, Trainline, Motorway, Preply, Canonical, LSEG, Lloyds Banking Group,
    RELX, Vodafone
  - Ireland: Tines, Wayflyer
  - Germany: Trade Republic, SumUp, Raisin, Solaris, HelloFresh, GetYourGuide, Delivery
    Hero, Grover, commercetools, Helsing, n8n, Parloa, Black Forest Labs, DeepL, Enpal,
    Bosch, ZEISS, Infineon
  - Netherlands: Catawiki, IMC Trading, Flow Traders, Elastic, Philips, Wolters Kluwer
  - France: Doctolib, Qonto, Alan, Pennylane, Back Market, Ledger, Pigment, Contentsquare,
    Dataiku, Photoroom, BlaBlaCar, Ubisoft, Airbus
  - Spain: Perk (TravelPerk), Typeform
  - Nordics and Baltics: Lovable, Legora, Pleo, Trustpilot, Supercell, Wolt, Veriff, Maersk
  - Switzerland and remote-in-Europe: Proton, Scandit, ClickHouse, Mozilla, Sanity,
    Fireblocks, Modal
- **global-remote (+18, plus Sourcegraph re-pointed)**: Netlify, Wikimedia Foundation, Mozilla, Metabase,
  ElevenLabs, Kraken, Improbable, Prefect, Hugging Face, ClickHouse, Temporal, 1Password,
  Bitwarden, Brave, Sentry, Snyk, Phantom, Zyte.
- **canada (new, 42)**:
  - Canadian companies: Wealthsimple, Cohere, Hootsuite, Hopper, Geotab, Neo Financial,
    Questrade, Waabi, Jobber, Float, D2L, Trulioo, PointClickCare, Fullscript
  - Canadian offices or Canada-remote hiring: 1Password, Faire, Tailscale, Honeycomb,
    Thumbtack, Asana, Ubisoft, Epic Games, Mozilla, Docker, Elastic, Lattice, Mercury,
    PagerDuty, Carta, Airbyte, Benchling, Stripe, Databricks, Pinterest, Instacart,
    DoorDash, Okta, Ramp, Coinbase, Amazon, Salesforce, Nvidia

Probed and **not** added: the Ashby `cursor` board (its postings now describe another
company); Ashby `lightspeed` (an Illinois firm, not Lightspeed Commerce); Greenhouse
`remote` (General Assembly, not Remote.com); Greenhouse `ritual` (identity unclear).
Also left out: boards with no in-market or no engineering roles today, such as Coursera
(us), Oura, SimCorp, Canva, TrueLayer (eu-uk), Ada, KOHO, Clearco (canada), Roblox,
Mixpanel, Netflix, Pocket FM (india), and Docker, Coder, Tailscale, Honeycomb, Toptal,
Elastic, Typeform, Render, Hex (global-remote: no worldwide roles). Workday guesses that
answered 422 were also left out: Dell, AMD, Arm, Synopsys, Western Digital, Booking.com,
ASML.

## Feeds

| Preset | Feeds | Change |
|---|---|---|
| india | unchanged (golden) | — |
| us | Himalayas US, Remotive, HN, Adzuna us, Careerjet en_US | — |
| eu-uk | Himalayas GB/DE/NL, Arbeitnow, Remotive, HN, Adzuna gb/de/**nl**, Careerjet en_GB/de_DE/**nl_NL** | + NL indexes, + HN "berlin" / "amsterdam" |
| global-remote | Himalayas (no country), Remotive, HN "remote" | — |
| canada | Himalayas CA, Remotive, HN canada/toronto/vancouver, Adzuna ca, Careerjet en_CA | new |

## Adapter TODOs found by the audit (packages/adapters, not changed here)

1. **Workday: a row without `externalPath` crashes the whole board.** Some tenants return a
   redacted posting (`{"bulletFields":["1211153"]}`, no title or path) in the list. The
   adapter's `idOf` then throws `Cannot read properties of undefined (reading 'match')`.
   This hit HPE, Harman, Citi, State Street and Mastercard in the final run, and also
   Barclays, Deutsche Bank and PwC in the first. Together that is about 1,500 India roles
   lost on every poll. Fix: drop rows without `externalPath` before mapping.
2. **Eightfold: no backoff on 429.** Microsoft's PCSX API rate-limits after about 12 pages,
   and the all-or-nothing list returns `[]`. The board has thousands of roles. Fix: retry a
   429 page with a delay, or keep the pages already fetched and mark the result partial.
3. **Eightfold v2 (Bayer)** returns a config object rather than `positions` for
   `/api/apply/v2/jobs?domain=bayer.com`. 0 rows.
4. **Greenhouse: work-mode locations.** Cloudflare's `location.name` is "Hybrid",
   "In-Office" or "Distributed", with the city in `offices[]`. Read `offices[].name` when
   the location is a bare work mode. That fixes Cloudflare's 482 roles in us / eu-uk.
5. **Workable (Mindera).** The adapter lists 36 roles with no India location, while the
   widget API showed 76 including Chennai. Check that the adapter reads every page.
6. **Himalayas: 429 "Get a free API key".** Anonymous requests from this egress hit the
   rate limit, which affects every preset's Himalayas feed. Add an optional
   `HIMALAYAS_API_KEY` (Bearer) and back off on 429.

## Wiring TODOs for new adapter sources

Once the adapters agent lands these sources, wire them in as preset feeds or seeds. Use new
stable feed ids, never renamed ones.

- **RemoteOK, Jobicy**: add `global-remote.remoteok` / `global-remote.jobicy`, plus
  `us.*` / `eu-uk.*` / `canada.*` targets if they take a region filter.
- **Personio**: Personio itself (`personio.jobs.personio.de`), and many DE/AT SMEs.
  Re-add Personio to eu-uk.
- **Teamtailor**: many Nordic employers, possibly Klarna (check whether `klarna.teamtailor.com`
  or a custom domain serves Teamtailor). Then Nordic seeds such as Epidemic Sound, Voi,
  Kry, Tibber and Einride, none of which have a Greenhouse / Ashby / Lever board.
- **Recruitee, BambooHR, Breezy**: EU and US SMBs. Re-probe the eu-uk candidates that had
  no board (Mambu, Taxfix, Blinkist, Babbel's full board, Pipedrive, Vinted, Bolt, Revolut,
  Zalando, Skyscanner, Monday.com).
- **apac preset**: not added. `parseLocation` doesn't place Singapore, Sydney or Tokyo in a
  country, and `COUNTRY_NAMES` lacks AU and JP, so APAC roles fail `isWorkableIn` and the
  Workday country facet. Add the preset once core normalization knows SG/AU/JP. Candidate
  boards already seen: Canva (SmartRecruiters), Atlassian, Grab, Airwallex.
- **Web app**: the onboarding wizard (`apps/web/components/OnboardingWizard.tsx`) and the
  search chips (`SearchView.tsx`) hard-code the four original preset ids. The wizard also
  maps CA to `us`. The CLI and the Sources page read `listPresets()` and already show
  `canada`.
- **Discovery quirk**: with no markets (`global-remote`), `detectChecked` verifies a
  name-only guess against **India** (the `plausibleBoard` default). It no longer matters
  for the presets, which all carry URLs now, but a user's name-only company list under
  global-remote is checked against India.

## Re-running the audit

The script is a ~120-line `tsx` file outside the repo: it imports `detect` / `atsAdapter`
from `packages/adapters/src`, `parseLocation` / `isWorkableIn` from `packages/core/src`,
`listPresets` from `packages/pipeline/src/presets` and `mapPoolKeyed` from
`packages/pipeline/src/discover.ts`. For each seed it records ats/slug, total, in-market,
in-market engineering and recent counts, plus the probe status on empty boards. With
concurrency 3, the india preset takes about 4 minutes (Workday paging dominates) and the
rest about 1 minute. Concurrency above 3 makes Workday lists fail intermittently.
