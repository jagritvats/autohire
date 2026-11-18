# Presets and discovery

Discovery decides **what JobFlow fetches**. Ranking decides what you see first. This guide
covers the first half: the built-in presets, the discovery plan the cron and `jobflow sync`
run, and how postings get tagged with presets. For how users see all this, read the
[search and discovery guide](../guides/search-and-discovery.md).

Discovery never filters what gets scored. A preset shapes which boards are polled, and every
fetched role is still ranked by the soft scorer (invariant #4).

## Where things live

| What | Where |
|---|---|
| Preset shape (`DiscoveryPreset`, `PresetFeed`) | `packages/pipeline/src/presets/types.ts` |
| The presets, as data | `packages/pipeline/src/presets/india.ts`, `global-remote.ts`, `us.ts`, `eu-uk.ts` |
| Curated employer lists for the non-India presets | `packages/pipeline/src/presets/companies.ts` |
| Registry, suggestion, preset tags | `packages/pipeline/src/presets/index.ts` |
| The discovery plan | `packages/pipeline/src/discovery.ts` (`resolveDiscoveryPlan`) |
| Which presets a tenant has on | `TenantConfig.discoveryPresets` and `activePresets()` in `packages/core/src/schema/entities.ts` |
| Custom source configs (RSS, JSON feed, Telegram, HN thread, company list) | `DiscoverySourceConfig` in `packages/core/src/schema/search.ts` |
| App-facing operations (list, switch, add source) | `packages/service/src/discovery.ts` |
| CLI and web | `apps/cli/src/commands/discovery.ts`, `apps/web/app/sources/page.tsx` |

## Anatomy of a preset

A preset (`DiscoveryPreset`) is plain data:

- `id`, `label`, `description`: shown in onboarding, on the Sources page and in
  `jobflow discovery list`.
- `markets`: ISO-2 countries that country-filtered boards are polled for. `[]` means
  location-agnostic (`global-remote`).
- `feeds`: `PresetFeed[]`, each a cloud adapter (`source`) plus the `targets` to fetch.
  `slow: true` marks a rate-limited feed that request-bound refreshes skip.
- `seedCompanies`: employers to resolve to boards. An entry with a `careersUrl` points at a
  known board. A name-only entry is resolved by the ATS detector at discover time, and kept
  only if the guessed board lists a recent role workable in the preset's markets.
- `telegramChannels`: public channels harvested for ATS links.
- `tier3`: hubs and queries for the **local agent's** sweep. The cloud never runs these.
- `profileDefaults`: currency, remote regions and location weights a new user in this
  market starts from.

### Feed ids are stable

Each feed has an id of the form `<preset id>.<source>` (for example
`global-remote.remotive`). Users switch individual feeds off and the ids are stored in
`TenantConfig.presetFeedsDisabled`. **Never rename or reuse a feed id.** Renaming one
silently switches a feed back on for everyone who turned it off. To retire a feed, delete
it. To change what it fetches, edit its `targets` and keep the id.

## Changing a preset

- **Add a seed employer.** Add an entry to the preset's `seedCompanies` (or to
  `presets/companies.ts`). Prefer a `careersUrl` on a public ATS board you have checked.
  Use only well-known public employers.
- **Add a feed.** The `source` must be a Tier 1–2 adapter registered in `ADAPTERS`. Give it
  a new stable id. If the source is new, write the adapter first
  ([adding-a-job-source.md](adding-a-job-source.md)).
- **The `india` preset is golden.** It is today's behaviour for existing installs and the
  default for unknown ids (`DEFAULT_PRESET_ID`). `packages/pipeline/test/discovery.test.ts`
  compares it with `packages/pipeline/test/fixtures/legacy-feeds.ts`. If you change it on
  purpose, update the fixture in the same commit and say why in the PR.

### Adding a new preset

1. Create `packages/pipeline/src/presets/<id>.ts` exporting a `DiscoveryPreset`.
2. Add it to the `PRESETS` array and the exports in `packages/pipeline/src/presets/index.ts`.
3. If it should be suggested during onboarding, extend `suggestPreset()`.
4. Update the preset list asserted in `packages/pipeline/test/discovery.test.ts` ("every
   preset has stable, unique feed ids over cloud adapters").
5. Mention it in the [search and discovery guide](../guides/search-and-discovery.md) and
   the CHANGELOG.

The CLI (`--preset`, `jobflow discovery use`) and the web Sources page read the list from
`listPresets()`, so no UI change is needed.

## The discovery plan

`resolveDiscoveryPlan(repo, opts)` builds one plan for the whole instance, as the **union
across tenants** of:

1. every preset each tenant switched on (minus their disabled feed ids, and minus sources
   outside an explicit `sourcesEnabled` allow-list; see `enabledSourcesOf`),
2. each tenant's custom sources, deduped by `configKey` so a feed many tenants share is
   fetched once,
3. saved searches marked `asSource`, mapped onto search-capable adapters with
   `adapter.toTargets()`.

It applies caps for politeness and cost: at most 5 searches per tenant, 3 targets per
(search, source) pair, and a per-source budget of 8 (all overridable through
`DiscoveryPlanOptions`). Countries to poll come from `JOBFLOW_POLL_COUNTRY`, else the tenants'
markets, else the presets' markets, else `IN`.

Every adapter in the plan is resolved through `cloudAdapter()` and its tier is checked
again, so a Tier-3 source can never come out of a plan, whatever a preset or saved search
names (invariant #1).

A user-typed careers URL in a company list is kept only if it passes the SSRF syntax and DNS
checks. The company still goes in by name, for the detector's name probe.

The plan is consumed by `pollAll` (`packages/pipeline/src/poll.ts`), which the CLI's
`jobflow sync`, the web app's background sync and the worker all call.

## Presets as tags

Presets double as tags on postings, for search (`--preset us`) and feed views.
`presetsForPosting(posting)` returns the presets a posting belongs to:

- its company is in the preset's seed list, or
- it came from a feed only that preset uses, or
- it came from a feed several presets share (HN, Remotive) **and** its location fits the
  preset's markets. A market-less preset takes remote roles open worldwide.

`presetFeedSources(ids)` lists the feed sources of those presets; a preset-tagged live search
asks exactly those sources. Tags only drive views, which hide on known values and report what
they hid. They never change a score.

## Testing

All of these run offline against `InMemoryRepository`:

| Test | Covers |
|---|---|
| `packages/pipeline/test/discovery.test.ts` | india golden, unique feed ids over cloud adapters, `suggestPreset`, plan unions, caps, cadence, the Tier-3 guard |
| `packages/pipeline/test/presets-multi.test.ts` | several presets per tenant, preset tags, `--preset` parsing |
| `packages/pipeline/test/poll-custom.test.ts` | custom RSS/JSON sources through the poll loop (adapter `fetch` stubbed) |
| `apps/cli/test/cli.test.ts` | `jobflow discovery use`, `preset-on/off`, `init --preset`, `search --preset` |

```bash
pnpm --filter @jobflow/pipeline test
pnpm --filter @jobflow/pipeline exec vitest run test/discovery.test.ts
```

To try a preset against the live boards without touching your own data, use a throwaway
data directory:

```bash
export JOBFLOW_DATA_DIR="$(mktemp -d)"
pnpm jobflow init --yes --sample --preset global-remote
pnpm jobflow sync && pnpm jobflow feed
```
