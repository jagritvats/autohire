import { activePresets, classifyLink, effectiveMarkets, normCompany, type DiscoverySource, type Profile, type SavedSearch, type SourceKind, type TenantConfig } from "@jobflow/core";
import { checkUrlSyntax, cloudAdapter, feedKeyFor, isSafeUrl, searchCapableAdapters, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import type { SeedCompany } from "./discover.js";
import { csvCountries } from "./ingest.js";
import { DEFAULT_TENANT } from "./seed.js";
import { DEFAULT_PRESET_ID, getPreset, type DiscoveryFeed, type DiscoveryPreset } from "./presets/index.js";

/**
 * The discovery PLAN (product plan "Configurable discovery"): what the cron polls, as the
 * UNION across tenants of
 *   - each tenant's built-in preset (minus the preset feeds they switched off),
 *   - their custom sources (RSS / JSON feeds, Telegram channels, HN threads, company lists),
 *   - their saved searches pushed into search-capable sources (`adapter.toTargets`),
 * deduped (custom sources by configKey, targets by JSON) and capped. Postings stay one
 * global corpus; the plan only decides what to fetch.
 *
 * Invariant #1: every adapter here is resolved through the CLOUD registry (`cloudAdapter`)
 * and its tier re-checked — a Tier-3 source can never come out of a plan, whatever a
 * saved search or preset names.
 */

/** a custom source's fetch, shared by every tenant that configured the same thing. */
export interface CustomSourceTarget {
  source: SourceKind;
  target: FetchTarget;
  /** configKey of the (deduped) source config */
  configKey: string;
  /** every DiscoverySource row (any tenant) this target serves — runs are recorded on each */
  sourceIds: string[];
}

/** one search-capable fetch, shared by every saved search that maps onto it. */
export interface SearchTarget {
  source: SourceKind;
  target: FetchTarget;
  searches: Array<{ tenantId: string; searchId: string }>;
}

export interface DiscoveryPlan {
  /** preset ids in use (any tenant) */
  presets: string[];
  feeds: DiscoveryFeed[];
  telegramChannels: string[];
  /** preset seed employers + custom company lists (deduped by name / careers URL) */
  seeds: SeedCompany[];
  /** ISO-2 countries country-filtered boards are polled for */
  pollCountries: string[];
  rssTargets: CustomSourceTarget[];
  jsonTargets: CustomSourceTarget[];
  /** custom HN threads */
  threads: CustomSourceTarget[];
  /** company_list sources (their companies are in `seeds`) — runs recorded after discovery */
  companyListSourceIds: string[];
  searchTargets: SearchTarget[];
}

export interface DiscoveryPlanOptions {
  /** environment to read JOBFLOW_POLL_COUNTRY from (default process.env). */
  env?: Record<string, string | undefined>;
  /** source-searches considered per tenant (default 5). */
  maxSearchesPerTenant?: number;
  /** targets per (search, source) (default 3). */
  maxTargetsPerSearchSource?: number;
  /** search targets per source across all tenants (default 8) — politeness / cost. */
  perSourceBudget?: number;
  /** only saved searches due by their cadence (default true; `manual` never runs here). */
  dueOnly?: boolean;
  now?: number;
}

/**
 * `TenantConfig.sourcesEnabled` shipped with this list as its default, before it filtered
 * anything — a tenant still holding exactly it never chose a restriction, so it's ignored.
 */
export const LEGACY_DEFAULT_SOURCES = ["greenhouse", "lever", "ashby", "workable", "remotive", "arbeitnow", "hn_whoishiring"];

/** the tenant's explicit source allow-list, or null (= no restriction). */
export function enabledSourcesOf(config: Pick<TenantConfig, "sourcesEnabled"> | null): Set<string> | null {
  const list = config?.sourcesEnabled ?? [];
  if (!list.length) return null;
  const set = new Set(list);
  const legacy = set.size === LEGACY_DEFAULT_SOURCES.length && LEGACY_DEFAULT_SOURCES.every((s) => set.has(s));
  return legacy ? null : set;
}

const DAY_MS = 86_400_000;

/** a saved search is due when its cadence has elapsed since the last run. */
export function isSearchDue(s: Pick<SavedSearch, "cadence" | "lastRunAt">, now = Date.now()): boolean {
  if (s.cadence === "manual") return false;
  if (!s.lastRunAt) return true;
  const last = new Date(s.lastRunAt as string | Date).getTime();
  const every = s.cadence === "weekly" ? 7 * DAY_MS : DAY_MS - 2 * 3_600_000; // daily, with slack for cron drift
  return !Number.isFinite(last) || now - last >= every;
}

/** a cloud adapter by source with the tier re-checked (invariant #1). */
function cloud(source: string): SourceAdapter | undefined {
  const a = cloudAdapter(source);
  return a && (a.tier === "tier1" || a.tier === "tier2") ? a : undefined;
}

export async function resolveDiscoveryPlan(repo: Repository, opts: DiscoveryPlanOptions = {}): Promise<DiscoveryPlan> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const maxSearches = opts.maxSearchesPerTenant ?? 5;
  const maxPerSearchSource = opts.maxTargetsPerSearchSource ?? 3;
  const perSourceBudget = opts.perSourceBudget ?? 8;

  // tenants that have set anything up (a config or a profile) contribute their preset; an
  // untouched placeholder tenant doesn't. With none at all (a fresh single-user install)
  // the default tenant's defaults apply — today's india discovery.
  const tenantIds = (await repo.listTenants()).map((t) => t.id);
  if (!tenantIds.length) tenantIds.push(DEFAULT_TENANT);
  const loaded = await Promise.all(
    tenantIds.map(async (id) => ({
      id,
      config: await repo.getConfig(id),
      profile: await repo.getProfile(id),
    })),
  );
  const configured = loaded.filter((t) => t.config || t.profile);
  const tenants = configured.length ? configured : [{ id: tenantIds.includes(DEFAULT_TENANT) ? DEFAULT_TENANT : tenantIds[0]!, config: null, profile: null }];

  // ── presets → feeds / seeds / channels / markets ──
  const presets: string[] = [];
  const feeds: DiscoveryFeed[] = [];
  const feedIds = new Set<string>();
  const targetSeen = new Set<string>(); // `${source}|${JSON(target)}` across feeds
  const seeds: SeedCompany[] = [];
  const seedKeys = new Set<string>();
  const channels: string[] = [];
  const presetMarkets: string[] = [];
  const tenantMarkets: string[] = [];

  const addSeed = (s: SeedCompany) => {
    const keys = [normCompany(s.name), s.careersUrl?.toLowerCase()].filter((k): k is string => !!k);
    if (!keys.length || keys.some((k) => seedKeys.has(k))) return;
    keys.forEach((k) => seedKeys.add(k));
    seeds.push(s);
  };
  const addChannel = (c: string) => {
    const ch = c.trim().replace(/^@/, "");
    if (ch && !channels.some((x) => x.toLowerCase() === ch.toLowerCase())) channels.push(ch);
  };

  for (const t of tenants) {
    // every preset the tenant switched on (multi-select), unioned with everyone else's
    const tenantPresets: DiscoveryPreset[] = activePresets(t.config)
      .map((id) => getPreset(id))
      .filter((p): p is DiscoveryPreset => !!p);
    if (!tenantPresets.length) tenantPresets.push(getPreset(DEFAULT_PRESET_ID)!);
    for (const preset of tenantPresets) {
      if (!presets.includes(preset.id)) presets.push(preset.id);
      const disabled = new Set(t.config?.presetFeedsDisabled ?? []);
      const enabled = enabledSourcesOf(t.config);
      for (const f of preset.feeds) {
        if (disabled.has(f.id) || feedIds.has(f.id)) continue;
        if (enabled && !enabled.has(f.source)) continue;
        if (!cloud(f.source)) continue; // never a non-cloud source (invariant #1)
        const targets = f.targets.filter((tg) => {
          const k = `${f.source}|${JSON.stringify(tg)}`;
          if (targetSeen.has(k)) return false;
          targetSeen.add(k);
          return true;
        });
        if (!targets.length) continue;
        feedIds.add(f.id);
        // an untouched preset feed is passed through as-is (the india preset stays identical)
        const { id: _id, ...feed } = f;
        feeds.push(targets.length === f.targets.length ? feed : { ...feed, targets });
      }
      preset.seedCompanies.forEach(addSeed);
      preset.telegramChannels.forEach(addChannel);
      for (const m of preset.markets) if (!presetMarkets.includes(m)) presetMarkets.push(m);
    }
    for (const m of t.profile ? effectiveMarkets(t.profile.prefs) : []) if (!tenantMarkets.includes(m)) tenantMarkets.push(m);
  }

  // pollCountries: env override → tenants' markets → presets' markets → IN
  const envCountries = csvCountries(env.JOBFLOW_POLL_COUNTRY);
  const pollCountries = envCountries.length ? envCountries : tenantMarkets.length ? tenantMarkets : presetMarkets.length ? presetMarkets : ["IN"];

  // ── custom discovery sources (deduped by configKey across tenants) ──
  const rssTargets: CustomSourceTarget[] = [];
  const jsonTargets: CustomSourceTarget[] = [];
  const threads: CustomSourceTarget[] = [];
  const companyListSourceIds: string[] = [];
  const byKey = new Map<string, CustomSourceTarget>();
  const sources: DiscoverySource[] = await repo.listAllEnabledDiscoverySources();
  const knownTenants = new Set(tenantIds);
  for (const src of sources) {
    if (!src.enabled || !knownTenants.has(src.tenantId)) continue;
    const cfg = src.config;
    const existing = byKey.get(src.configKey);
    if (existing) {
      existing.sourceIds.push(src.id);
      continue;
    }
    let entry: CustomSourceTarget | null = null;
    switch (cfg.kind) {
      case "rss":
        entry = {
          source: "rss",
          configKey: src.configKey,
          sourceIds: [src.id],
          target: { limit: 200, params: { url: cfg.url, feedKey: feedKeyFor(cfg.url), ...(cfg.company ? { company: cfg.company } : {}) } },
        };
        rssTargets.push(entry);
        break;
      case "json_feed":
        entry = {
          source: "json_feed",
          configKey: src.configKey,
          sourceIds: [src.id],
          target: { limit: 500, params: { url: cfg.url, feedKey: feedKeyFor(cfg.url), mapping: JSON.stringify(cfg.mapping) } },
        };
        jsonTargets.push(entry);
        break;
      case "hn_thread":
        entry = {
          source: "hn_whoishiring",
          configKey: src.configKey,
          sourceIds: [src.id],
          target: { limit: 300, ...(cfg.storyId ? { params: { storyId: cfg.storyId } } : {}) },
        };
        threads.push(entry);
        break;
      case "telegram":
        addChannel(cfg.channel);
        break;
      case "company_list":
        for (const c of cfg.companies) {
          // a user-typed careers URL is fetched by the detector — only a safe one is kept
          // (the company still goes in by name, for the detector's name probe)
          const url = c.careersUrl && (await userUrlOk(c.careersUrl)) ? c.careersUrl : null;
          addSeed({ name: c.name, ...(url ? { careersUrl: url } : {}), tags: ["custom"] });
        }
        companyListSourceIds.push(src.id);
        break;
    }
    if (entry) byKey.set(src.configKey, entry);
  }

  // ── saved searches → search-capable sources ──
  const searchTargets: SearchTarget[] = [];
  const searchByKey = new Map<string, SearchTarget>();
  const perSource = new Map<string, number>();
  const allSearches = (await repo.listAllSourceSearches()).filter(
    (s) => s.enabled && s.asSource && knownTenants.has(s.tenantId) && (opts.dueOnly === false || isSearchDue(s, now)),
  );
  for (const t of loaded) {
    const mine = allSearches
      .filter((s) => s.tenantId === t.id)
      // least-recently-run first, so a tenant over the cap rotates through its searches
      .sort((a, b) => runAt(a) - runAt(b) || a.name.localeCompare(b.name))
      .slice(0, maxSearches);
    if (!mine.length) continue;
    const enabled = enabledSourcesOf(t.config);
    const markets = t.profile ? effectiveMarkets(t.profile.prefs) : [];
    const ctx = { markets: markets.length ? markets : pollCountries, yoe: t.profile?.yoe ?? 0 };
    for (const s of mine) {
      for (const adapter of adaptersForSearch(s, enabled)) {
        const targets = (adapter.toTargets?.(s.query, ctx) ?? []).slice(0, maxPerSearchSource);
        for (const target of targets) {
          const key = `${adapter.source}|${JSON.stringify(target)}`;
          let st = searchByKey.get(key);
          if (!st) {
            const used = perSource.get(adapter.source) ?? 0;
            if (used >= perSourceBudget) continue;
            perSource.set(adapter.source, used + 1);
            st = { source: adapter.source, target, searches: [] };
            searchByKey.set(key, st);
            searchTargets.push(st);
          }
          if (!st.searches.some((x) => x.searchId === s.id)) st.searches.push({ tenantId: s.tenantId, searchId: s.id });
        }
      }
    }
  }

  return {
    presets,
    feeds,
    telegramChannels: channels,
    seeds,
    pollCountries,
    rssTargets,
    jsonTargets,
    threads,
    companyListSourceIds,
    searchTargets,
  };
}

/**
 * SSRF check for a user-supplied careers URL (the detector fetches it): syntax always; a
 * DNS check unless it's a known ATS host (a fixed public API — no lookup needed).
 */
async function userUrlOk(url: string): Promise<boolean> {
  try {
    checkUrlSyntax(url);
  } catch {
    return false;
  }
  if (classifyLink(url).kind === "ats") return true;
  return isSafeUrl(url);
}

function runAt(s: Pick<SavedSearch, "lastRunAt">): number {
  return s.lastRunAt ? new Date(s.lastRunAt as string | Date).getTime() : 0;
}

/**
 * The cloud adapters a saved search reaches: the sources it names (each must be a
 * search-capable CLOUD adapter — a Tier-3 name resolves to nothing), else every
 * search-capable cloud adapter the tenant has enabled.
 */
export function adaptersForSearch(s: Pick<SavedSearch, "query">, enabled: Set<string> | null = null): SourceAdapter[] {
  const named = s.query.sources;
  const list = named.length
    ? named.map((src) => cloud(src)).filter((a): a is SourceAdapter => !!a && typeof a.toTargets === "function")
    : searchCapableAdapters().filter((a) => !enabled || enabled.has(a.source));
  return list.filter((a) => a.tier === "tier1" || a.tier === "tier2");
}

/** a profile-less helper for callers that just want a tenant's markets (or the plan's). */
export function marketsFor(profile: Profile | null, fallback: string[]): string[] {
  const m = profile ? effectiveMarkets(profile.prefs) : [];
  return m.length ? m : fallback;
}
