# Adding a job source

A job source is one class in `packages/adapters` and one line in a registry. The pipeline,
the scorer and both UIs pick it up without other changes. This guide covers how to write
the adapter, which tier it belongs to, and how to test it without the network.

Before you start, open a [New job source](../../.github/ISSUE_TEMPLATE/new-source.yml) issue
if you are not sure about the tier or the source's terms of service. See
[legal-and-ethics.md](../legal-and-ethics.md) for the policy behind tiers.

## 1. Pick the tier

The tier decides **where** an adapter may run, not how good the source is
(`ExecutionTier` in `packages/core/src/schema/enums.ts`).

| Tier | Means | Runs in | Examples |
|---|---|---|---|
| `tier1` | an official or public API, no login | CLI, web server, worker, cron | Greenhouse, Lever, Ashby, Remotive, user RSS/JSON feeds |
| `tier2` | public, low-risk: the JSON a company's own careers page calls | CLI, web server, worker, cron | Workday, Eightfold, Keka, Hirist, Cutshort |
| `tier3` | needs a login, or the site blocks non-browser clients | **only the local agent**, in the user's own browser session | LinkedIn, Naukri, Glassdoor, AmbitionBox, Darwinbox, Peerlist |

Tier 3 is a hard boundary (invariant #1 in [CLAUDE.md](../../CLAUDE.md)). If a source
needs cookies, a logged-in session or a real browser, it is Tier 3. There is no server-side
workaround. See [Tier-3 sources](#tier-3-sources) below.

## 2. Write the adapter

Create `packages/adapters/src/<group>/<name>.ts`. Existing groups are `ats/` (company
boards), `aggregators/` (multi-company boards and search APIs), `india/` (India tech boards),
`feeds/` (user-configured RSS/JSON), `hn/` and `community/`.

An adapter implements `SourceAdapter` from `packages/adapters/src/types.ts`:

```ts
export interface SourceAdapter {
  readonly source: SourceKind;      // add a new value to SourceKind in core/src/schema/enums.ts
  readonly tier: ExecutionTier;
  fetch(target: FetchTarget): Promise<RawPosting[]>;
  isLive?(job: LivenessTarget): Promise<boolean | null>;              // optional
  toTargets?(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[]; // optional
  readonly searchCaps?: SearchCaps;                                   // with toTargets
}
```

`packages/adapters/src/ats/lever.ts` is a short, complete example of a board.
`packages/adapters/src/aggregators/remotive.ts` is a short example of a searchable feed.

### `fetch(target)`

- For a company board, `target.slug` is the board slug. For a feed, read `target.query`,
  `target.location`, `target.limit` and `target.params`.
- Use the helpers in `types.ts`: `httpJson` and `httpText` (timeout plus a polite
  User-Agent, `null` on any failure) and `htmlToText` for HTML job descriptions.
- **Return `[]` on any recoverable error. Never throw into the pipeline.** Ingest treats an
  empty result as "unknown", not "the board is empty", so a failed fetch never retires
  postings (`pollCompany` in `packages/pipeline/src/ingest.ts`).
- If you return only part of a board (you stopped at a page cap, or fell back to an
  unfiltered list), wrap the array in `markPartial(...)`. Ingest then skips `markStale` for
  that poll, because a missing posting may still be live (invariant #5). `ats/workday.ts`
  shows the pattern. A "most recent N" window is a page cap too: compare what you listed
  with the board's own total (`ats/amazon.ts`, `ats/eightfold.ts`).
- Paged lists sorted by date or relevance shift while you page (a new posting pushes a row
  onto the next page), so the same id can arrive twice. Dedupe by id before returning.
- If the source rate-limits bursts (429/503), fetch with `httpJsonPolite`: it backs off
  (honouring `Retry-After`) and retries, and gives up at once on any other error.
  `ats/eightfold.ts` uses it for Microsoft's tenant. Its `onGiveUp` hook reports the last
  status, so you can say why a source returned nothing: `adapterNotice(source, reason)`
  logs a reason once per process (`aggregators/himalayas.ts` does this for a keyless 429).
- If the source's terms cap how often you may poll it, enforce the cap **in the adapter**,
  not only in presets: a saved search, a second preset or a page-load refresh can call it
  too. `aggregators/jobicy.ts` (one pass an hour per target) and `aggregators/jsearch.ts`
  (a spend guard) keep a per-process "last fetched" map and return `[]` without a request.
- A malformed answer must never throw into the pipeline. If the mapping code can trip on
  a field the source sometimes leaves out, guard it or wrap `fetch` and return `[]`
  (`ats/workday.ts` skips redacted rows and is total).
- Fill `RawPosting` (`packages/core/src/schema/entities.ts`) with what the source **states**.
  Put the raw salary text in `salaryRaw` and let `normalize/salary.ts` parse it. Don't
  invent a `postedAt`; leave it `null` when the source has none.
- Boards that need one request per posting for the description should honour
  `target.known` (skip ids already stored) and cap detail calls with `DETAIL_CAP` and
  `pickForDetail`. `ats/smartrecruiters.ts` and `ats/eightfold.ts` do this.

### Ids: `atsType`, `atsJobId` and `scopedJobId`

Postings are keyed on `(atsType, atsJobId)` and upserted idempotently.

- A company ATS (`atsType` is not `"unknown"`) uses the ATS's own job id.
- Anything else sets `atsType: "unknown"`. Ingest stores it under `scopedJobId(raw)`
  (`packages/core/src/normalize/index.ts`), which prefixes the source (`remotive:9101`), so
  two feeds can't collide on the same number. Generic feeds go one step further and prefix
  a per-feed key (`feeds/rss.ts`).

Never insert postings yourself. Return raws; the pipeline upserts them.

### `isLive(job)` (optional)

Add it only if the source has a per-job endpoint that says definitively that a job is gone.
Return `false` only for a per-job 404/410 or the board's own closed flag, `true` when it is
listed, and `null` when you can't tell (network error, 403, 429, 5xx). `httpStatus` and
`liveFromStatus` in `types.ts` implement exactly that rule. `httpStatus` doesn't follow
redirects and returns the `location` header, for sources whose "gone" answer is a redirect
(`ats/breezy.ts`: a removed position redirects to the portal root). Pass
`redirect: "follow"` when a redirect only moves the page (`ats/teamtailor.ts`). `checkLiveness`
(`packages/pipeline/src/liveness.ts`) retires a posting only on `false`.

### `toTargets` and `searchCaps` (optional)

Implement these if the source can answer a keyword search. `toTargets` turns a user's
`SearchQuery` into at most three `FetchTarget`s (`MAX_TARGETS_PER_QUERY`). It is pure: no
I/O. Return `[]` when the source can't serve the query, for example a remote-only board and
`q.remote === "exclude"`, or an India-only board and a US search (`inIndia`). Reuse the
helpers in `packages/adapters/src/search.ts` (`queryTerms`, `queryCountries`, `queryCity`,
`crossCapped`, `expWindow`).

`searchCaps` declares what the source filters server-side and what a call costs (`free`,
`keyed`, `paid`). A query only shapes **what is fetched**. It never becomes a match filter
(invariant #4).

Search-capable adapters are found by `searchCapableAdapters()` and used by live search
(`packages/pipeline/src/search.ts`) and by saved searches in the discovery plan.

## 3. Register it

1. Add the source to `SourceKind` (and to `AtsType` if it is a company ATS) in
   `packages/core/src/schema/enums.ts`.
2. Add one line to `ADAPTERS` in `packages/adapters/src/registry.ts`, and export the class
   (plus any pure parser you want to test) from `packages/adapters/src/index.ts`.
3. Add a trust prior to `SOURCE_TRUST` in `packages/core/src/match/trust.ts`. Use 0.85 for
   an employer's own ATS, and lower for aggregators that repost. Comment the reason.
4. If the source's "posted" date is when **it** ingested or re-stamped the job (common for
   aggregators), add it to `REDATED_SOURCES` in the same file. Freshness is then capped.
5. For a company ATS, teach the detector to recognise it: add a URL pattern to
   `URL_PATTERNS` and a `probe()` case in `packages/adapters/src/detector/index.ts`, with a
   test in `packages/adapters/test/boards.test.ts`.
6. To poll a feed as part of a market's discovery, add it to a preset. See
   [presets-and-discovery.md](presets-and-discovery.md).

Key-gated sources (`aggregators/adzuna.ts`, `careerjet.ts`, `jsearch.ts`) return `[]`
without making a request until their environment keys are set. Document new keys in
[configuration.md](../configuration.md) and `.env.example`.

## 4. User-supplied URLs: the SSRF guard

When a URL comes from a user (a custom feed, a careers URL in a company list), the server
fetches it, so it must not reach the server itself, the private network or a cloud metadata
endpoint. `packages/adapters/src/net.ts` provides:

- `safeUrl(url)`: https only (http only with `JOBFLOW_ALLOW_HTTP_FEEDS=1`), no credentials,
  a public host whose every DNS answer is a public address. Throws `UnsafeUrlError`.
- `checkUrlSyntax(url)`: the same checks without DNS, for validating input early.
- `safeFetchText(url, opts)`: a GET that re-checks every redirect hop and the address it
  actually connects to (DNS rebinding), with a timeout and a size cap.

Fetch user URLs **only** through `safeFetchText`. `feeds/rss.ts` takes the fetcher as a
constructor argument so tests can inject a fake one; production always uses
`safeFetchText`. `resolveDiscoveryPlan` drops a company-list careers URL that fails the
check (`userUrlOk` in `packages/pipeline/src/discovery.ts`).

## 5. Test it with fixtures

Tests never call a live API. Put them in `packages/adapters/test/`:

- **Parse a recorded payload.** Export a pure parser (`parseAdzunaResults`,
  `parseJobviteXml`, `parseCutshortPage`) and test it on a trimmed, fictional sample.
- **Or stub `fetch`.** `packages/adapters/test/aggregators.test.ts` shows `stubFetch` with
  `vi.stubGlobal("fetch", …)` and `vi.unstubAllGlobals()` in `afterEach`.
- Check the error path: a non-200 or malformed answer returns `[]`.
- If you added `toTargets`, extend `packages/adapters/test/search-targets.test.ts` (at most
  three targets, `[]` for queries the source can't serve).
- Fixtures use fictional companies and people (`Example Corp`, `sam@example.com`). Don't
  paste a real posting that names a real recruiter. `node scripts/check-pii.mjs` runs in CI.

Then run the package and the live smoke test:

```bash
pnpm --filter @jobflow/adapters test
pnpm -r build && pnpm demo        # optional: hits live free APIs, prints match cards
```

## Tier-3 sources

Tier-3 code lives in `packages/adapters/src/tier3/` and follows extra rules:

- **Never register it in `ADAPTERS`.** `cloudAdapters()`, `cloudAdapter()` and
  `resolveDiscoveryPlan` re-check the tier, and
  `packages/pipeline/test/discovery.test.ts` fails if a Tier-3 source ever comes out of a
  discovery plan, even one registered by mistake.
- The class owns only URL building and pure HTML/JSON parsing. The network belongs to the
  local agent, which injects `localFetch` / `localFetchJson` (a Playwright page in the
  user's own session) through `Tier3Context` in `tier3/index.ts`. Without them the adapter
  refuses to run.
- Each source is off by default and opt-in by name through `JOBFLOW_TIER3_SOURCES`
  (`Tier3DisabledError` otherwise). The agent paces requests like a person.
- The agent's handlers live in `apps/agent/src/handlers.ts`. No server code may hold a
  user's LinkedIn, Naukri or Glassdoor session.
- Test the parsers offline in `packages/adapters/test/tier3.test.ts` and
  `packages/adapters/test/tier3-local.test.ts`.

## Checklist

- [ ] `fetch` returns `[]` on errors, and `markPartial` on a partial board
- [ ] `isLive` (if any) returns `false` only on a definitive "gone"
- [ ] `SourceKind` / `AtsType`, `ADAPTERS`, `index.ts` exports, `SOURCE_TRUST`,
      `REDATED_SOURCES` (if re-dated), detector (if an ATS)
- [ ] user URLs go through `safeFetchText`
- [ ] fixture tests, fictional data, no live HTTP
- [ ] Tier 3: in `tier3/`, not in `ADAPTERS`, flag-guarded, agent-only
