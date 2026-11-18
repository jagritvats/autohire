import { createHash } from "node:crypto";
import { presetFeedSources, presetsForPosting } from "./presets/index.js";
import {
  SearchQuery,
  applyView,
  countryCodeFromText,
  parseMoneyInput,
  payForSort,
  resolveDisplayCurrency,
  effectiveMarkets,
  emptyHiddenCounts,
  normalizePosting,
  scopedJobId,
  scorePosting,
  searchRelevance,
  type LevelBand,
  type Posting,
  type Profile,
  type RawPosting,
  type SalaryPeriod,
  type SavedSearch,
  type ScoredMatch,
  type SearchQueryInput,
  type SourceKind,
  type ViewHiddenReason,
} from "@jobflow/core";
import { LevelBand as LevelBandEnum, RemoteGeo as RemoteGeoEnum, SourceKind as SourceKindEnum } from "@jobflow/core";
import { cloudAdapter, searchCapableAdapters, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { ingestFromAdapter, ingestRaws, toNewPosting, type IngestStats } from "./ingest.js";
import { adaptersForSearch, enabledSourcesOf } from "./discovery.js";
import { localEmbedder, type Embedder } from "./embedder.js";

/**
 * Specific job searches (product plan "Specific job searches"). A saved search drives
 * search-capable Tier 1-2 sources (`runSavedSearch`, idempotent ingest into the shared
 * corpus); an ad-hoc search (`adhocSearch`) fetches, scores with the SAME scorer and shows
 * a view — without writing anything unless asked to keep the results. Ranking stays
 * soft: the query shapes what's fetched and what the view shows, never a score
 * (invariant #4). Only cloud adapters are reachable (invariant #1).
 */

const MAX_TARGETS = 3;

export interface SavedSearchRunResult {
  fetched: number;
  upserted: number;
  bySource: Record<string, number>;
  errors: string[];
}

/** Run one saved search now: fetch from its sources, ingest (idempotent), record the run. */
export async function runSavedSearch(
  repo: Repository,
  search: SavedSearch,
  opts: { embedder?: Embedder; markets: string[]; yoe: number },
): Promise<SavedSearchRunResult> {
  const embedder = opts.embedder ?? localEmbedder;
  const out: SavedSearchRunResult = { fetched: 0, upserted: 0, bySource: {}, errors: [] };
  const config = await repo.getConfig(search.tenantId).catch(() => null);
  const query = SearchQuery.parse(search.query);
  for (const adapter of adaptersForSearch({ query }, enabledSourcesOf(config))) {
    const targets = (adapter.toTargets?.(query, { markets: opts.markets, yoe: opts.yoe }) ?? []).slice(0, MAX_TARGETS);
    for (const target of targets) {
      const r: IngestStats = await ingestFromAdapter(repo, adapter, target, { embedder });
      out.fetched += r.fetched;
      out.upserted += r.upserted;
      out.bySource[adapter.source] = (out.bySource[adapter.source] ?? 0) + r.fetched;
      out.errors.push(...r.errors);
    }
  }
  await repo.recordSavedSearchRun(search.tenantId, search.id, {
    fetched: out.fetched,
    upserted: out.upserted,
    sources: out.bySource,
    errors: out.errors.slice(0, 5),
    via: "run",
  });
  return out;
}

export interface AdhocResultItem {
  posting: Posting;
  match: ScoredMatch;
  /** how well the posting answers the query's terms ∈ [0,1] (separate from the score) */
  relevance: number;
  /** the corpus already holds this posting (it's in the user's feed) */
  inFeed: boolean;
}

export interface AdhocSearchResult {
  query: SearchQuery;
  /** ranked (score desc), shown by the view, hard-exclusion-free, capped at `limit` */
  results: AdhocResultItem[];
  /** what the VIEW hid, per reason (never silent) */
  hidden: Record<ViewHiddenReason, number>;
  hiddenTotal: number;
  /** results the scorer's own hard exclusions removed (salary floor / impossible location) */
  excluded: number;
  /** raw postings fetched, and per source */
  fetched: number;
  bySource: Record<string, number>;
  /** sources asked (after resolving the query's `sources`) */
  sources: SourceKind[];
  errors: string[];
  /** only when `ingest: true` */
  ingested?: number;
}

export interface AdhocSearchOptions {
  embedder?: Embedder;
  /** restrict to these sources (else the query's `sources`, else every search-capable cloud source) */
  sources?: SourceKind[];
  /** read-only use: mark results already in the corpus (`inFeed`) and score the stored copy */
  repo?: Repository;
  /** also ingest what was fetched (idempotent) — needs `repo`. Default false: no writes. */
  ingest?: boolean;
  /** max results returned (default 50) */
  limit?: number;
  /**
   * "score" (default), "relevance" (the query's terms first, score breaks ties) or "pay"
   * (annual pay in ONE currency — stated top, else the estimate's median — via FX; unknown last)
   */
  sort?: "score" | "relevance" | "pay";
  now?: number;
  /** adapters to use instead of the registry's (tests) — still tier-checked */
  adapters?: SourceAdapter[];
  /**
   * apply the scorer's hard exclusions (salary floor / impossible location). Default true.
   * Pass false for a profile that isn't set up yet: a blank profile has no floor and no
   * location, so excluding against it would be inventing preferences.
   */
  hardExclude?: boolean;
}

/** an id for a transient posting: stable per (atsType, scoped id), uuid-shaped. */
function transientId(atsType: string, atsJobId: string): string {
  const h = createHash("sha1").update(`${atsType}:${atsJobId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const TRANSIENT_COMPANY = "00000000-0000-0000-0000-00000000c0de";

/**
 * One-off search: fetch from search-capable CLOUD sources, normalize, build TRANSIENT
 * postings, score them with the existing scorer, apply the query as a view, and return
 * them ranked with hidden counts. Writes NOTHING unless `ingest: true` (then the fetched
 * postings are upserted exactly like a feed's — idempotent, invariant #5).
 */
export async function adhocSearch(
  queryInput: SearchQuery | SearchQueryInput,
  profile: Profile,
  opts: AdhocSearchOptions = {},
): Promise<AdhocSearchResult> {
  const query = SearchQuery.parse(queryInput);
  const embedder = opts.embedder ?? localEmbedder;
  const now = opts.now ?? Date.now();
  const markets = effectiveMarkets(profile.prefs);
  const ctx = { markets, yoe: profile.yoe };
  const named = opts.sources ?? query.sources;
  const q = named.length && !query.sources.length ? { ...query, sources: named } : query;

  // a preset tag with no explicit sources searches those presets' own feeds
  const presetSources = !named.length && query.presets.length ? presetFeedSources(query.presets) : [];
  const pool =
    opts.adapters ??
    (named.length
      ? named.map((s) => cloudAdapter(s)).filter((a): a is SourceAdapter => !!a)
      : presetSources.length
        ? searchCapableAdapters().filter((a) => presetSources.includes(a.source))
        : searchCapableAdapters());
  const adapters = pool.filter((a) => (a.tier === "tier1" || a.tier === "tier2") && typeof a.toTargets === "function");

  const errors: string[] = [];
  const bySource: Record<string, number> = {};
  const fetchedBySource = await Promise.all(
    adapters.map(async (adapter) => {
      const targets: FetchTarget[] = (adapter.toTargets?.(q, ctx) ?? []).slice(0, MAX_TARGETS);
      const raws: RawPosting[] = [];
      for (const target of targets) {
        try {
          raws.push(...(await adapter.fetch(target)));
        } catch (e) {
          errors.push(`${adapter.source}: ${(e as Error).message}`);
        }
      }
      bySource[adapter.source] = raws.length;
      return { adapter, raws };
    }),
  );

  // dedupe by key (one source can return a role twice across targets) and by canonical
  // company+title+place (the same role via two aggregators)
  const seenIds = new Set<string>();
  const seenDedup = new Set<string>();
  const items: Array<{ raw: RawPosting; source: SourceKind }> = [];
  for (const { adapter, raws } of fetchedBySource) {
    for (const raw of raws) {
      const key = `${raw.atsType}:${scopedJobId(raw)}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      items.push({ raw, source: adapter.source });
    }
  }
  const fetched = items.length;

  // read-only: which of these the corpus already holds
  const stored = new Map<string, Posting>();
  if (opts.repo) {
    const byType = new Map<string, string[]>();
    for (const { raw } of items) byType.set(raw.atsType, [...(byType.get(raw.atsType) ?? []), scopedJobId(raw)]);
    for (const [atsType, ids] of byType) {
      for (const p of await opts.repo.findPostingsByAtsIds(atsType as Posting["atsType"], ids)) stored.set(`${p.atsType}:${p.atsJobId}`, p);
    }
  }

  const scored: Array<AdhocResultItem & { posting: Posting }> = [];
  let excluded = 0;
  for (const { raw } of items) {
    const n = normalizePosting(raw);
    if (seenDedup.has(n.dedupKey)) continue;
    seenDedup.add(n.dedupKey);
    const prior = stored.get(`${n.atsType}:${n.atsJobId}`);
    let posting: Posting;
    if (prior && prior.status === "active") {
      posting = prior;
    } else {
      const np = await toNewPosting(n, TRANSIENT_COMPANY, n.companyName, embedder, prior);
      const seen = new Date(now).toISOString();
      posting = {
        ...np,
        id: transientId(n.atsType, n.atsJobId),
        firstSeen: prior?.firstSeen ?? seen,
        lastSeen: seen,
        isActive: true,
        repostCount: 0,
        status: "active",
        invalidReason: null,
        invalidatedAt: null,
        canonicalId: null,
      };
    }
    const match = scorePosting(posting, profile);
    if (!match.rulePass && opts.hardExclude !== false) {
      excluded++;
      continue;
    }
    scored.push({ posting, match, relevance: searchRelevance(posting, q), inFeed: !!prior && prior.status === "active" });
  }

  const view = applyView(scored, q, { now, presetsOf: presetsForPosting });
  const payCurrency = resolveDisplayCurrency(profile.prefs) ?? profile.prefs.currency;
  const pay = new Map(opts.sort === "pay" ? view.shown.map((r) => [r, payForSort(r.posting, payCurrency) ?? -1] as const) : []);
  const ranked = [...view.shown].sort((a, b) =>
    opts.sort === "pay"
      ? pay.get(b)! - pay.get(a)! || b.match.score - a.match.score
      : opts.sort === "relevance"
        ? b.relevance - a.relevance || b.match.score - a.match.score
        : b.match.score - a.match.score || b.relevance - a.relevance,
  );

  const result: AdhocSearchResult = {
    query: q,
    results: ranked.slice(0, opts.limit ?? 50),
    hidden: view.hidden ?? emptyHiddenCounts(),
    hiddenTotal: view.hiddenTotal,
    excluded,
    fetched,
    bySource,
    sources: adapters.map((a) => a.source),
    errors,
  };

  if (opts.ingest && opts.repo) {
    let n = 0;
    for (const { adapter, raws } of fetchedBySource) if (raws.length) n += await ingestRaws(opts.repo, adapter.source, raws, embedder);
    result.ingested = n;
  }
  return result;
}

// ── "staff backend" --remote --loc Berlin,DE --seniority senior → SearchQuery ──

export interface SearchFlags {
  remote?: boolean | "any" | "only" | "exclude";
  /** "Berlin,DE" / "Bengaluru" / "US" — several as an array or ";"-separated */
  loc?: string | string[];
  country?: string | string[];
  seniority?: string | string[];
  /** "150000 USD" / "150000USD" / "40L INR" / a number (with `currency`) */
  minSalary?: string | number;
  currency?: string;
  /** days, or "7d" / "2w" */
  posted?: string | number;
  sources?: string | string[];
  must?: string | string[];
  nice?: string | string[];
  title?: string | string[];
  excludeCompany?: string | string[];
  exclude?: string | string[];
  /** discovery-preset tags: `india`, `us`, `eu-uk`, `global-remote` */
  preset?: string | string[];
}

/** split quoted phrases + flags: `"staff backend" --loc "New York,US" --remote` */
export function tokenizeSearch(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((t) => t !== "");
}

const FLAG_ALIASES: Record<string, keyof SearchFlags | "onsite"> = {
  remote: "remote",
  "remote-only": "remote",
  onsite: "onsite",
  "no-remote": "onsite",
  loc: "loc",
  location: "loc",
  l: "loc",
  country: "country",
  seniority: "seniority",
  level: "seniority",
  "min-salary": "minSalary",
  salary: "minSalary",
  currency: "currency",
  posted: "posted",
  within: "posted",
  "posted-within": "posted",
  source: "sources",
  sources: "sources",
  must: "must",
  skills: "must",
  nice: "nice",
  title: "title",
  "exclude-company": "excludeCompany",
  "exclude-companies": "excludeCompany",
  exclude: "exclude",
  "exclude-keyword": "exclude",
  preset: "preset",
  presets: "preset",
  tag: "preset",
};
const BOOLEAN_FLAGS = new Set(["remote", "onsite"]);
const CURRENCY_CODE = /^(USD|EUR|GBP|INR|CAD|AUD|SGD|CHF|JPY|NZD|SEK|NOK|DKK|PLN|AED|BRL|MXN|ZAR|HKD|CZK|HUF|RON|TRY|ILS|KRW|CNY)(?:\/(?:yr|year|mo|month|wk|week|day|hr|hour))?$/i;

function list(v: string | string[] | undefined, sep = /[,;]/): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(sep)).map((x) => x.trim()).filter(Boolean);
}

/** "Berlin,DE" → {city, country}; "US" → country; "Bengaluru" → city + inferred IN. */
function parseLoc(s: string): { city: string | null; country: string | null } | "remote" {
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { city: null, country: null };
  if (parts.length === 1 && /^remote$/i.test(parts[0]!)) return "remote";
  const last = parts[parts.length - 1]!;
  if (/^[A-Za-z]{2}$/.test(last)) {
    const city = parts.slice(0, -1).join(", ") || null;
    return { city, country: last.toUpperCase() };
  }
  const city = parts.join(", ");
  return { city, country: countryCodeFromText(city) };
}

/** "40L INR", "$120k", "5000 EUR/mo" → an ANNUAL amount — the same grammar postings are parsed with (core). */
function parseMoney(v: string | number, currency?: string): { amount: number; currency: string; period: SalaryPeriod } | null {
  return parseMoneyInput(v, currency);
}

function parseDays(v: string | number): number | null {
  if (typeof v === "number") return v > 0 ? Math.round(v) : null;
  const m = v.trim().match(/^(\d+)\s*(d|days?|w|weeks?|m|months?)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "d")[0]!.toLowerCase();
  const days = unit === "w" ? n * 7 : unit === "m" ? n * 30 : n;
  return days > 0 ? days : null;
}

const SENIORITY_WORDS: Record<string, LevelBand> = { entry: "junior", sde1: "junior", sde2: "mid", sde3: "senior", intermediate: "mid" };

/**
 * Turn CLI-style input into a SearchQuery: bare words form one phrase, quoted phrases are
 * separate keywords, `--flags` fill the facets (`--remote`, `--onsite`, `--loc Berlin,DE`,
 * `--seniority senior,staff`, `--min-salary 150k USD`, `--posted 7d`, `--source himalayas`,
 * `--must go,kafka`, `--nice rust`, `--title "platform engineer"`, `--exclude-company Foo`,
 * `--exclude crypto`). `flags` (e.g. from a CLI parser) merge on top of what the text says.
 */
export function makeSearchQuery(text: string, flags: SearchFlags = {}): SearchQuery {
  const tokens = tokenizeSearch(text ?? "");
  const f: SearchFlags & { onsite?: boolean } = {};
  const keywords: string[] = [];
  let phrase: string[] = [];
  const flushPhrase = () => {
    if (phrase.length) keywords.push(phrase.join(" "));
    phrase = [];
  };
  const quoted = new Set([...(text ?? "").matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? ""));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const flag = tok.startsWith("--") ? tok.slice(2).toLowerCase() : null;
    if (flag) {
      flushPhrase();
      const [name, inline] = flag.includes("=") ? [flag.slice(0, flag.indexOf("=")), tok.slice(tok.indexOf("=") + 1)] : [flag, null];
      const key = FLAG_ALIASES[name!];
      if (!key) continue;
      if (BOOLEAN_FLAGS.has(name!) || key === "onsite") {
        if (key === "onsite") f.onsite = true;
        else f.remote = true;
        continue;
      }
      let value = inline ?? tokens[i + 1];
      if (inline == null) i++;
      if (value == null) continue;
      // "--min-salary 40L INR": a currency code after the amount belongs to it
      if (key === "minSalary" && inline == null && CURRENCY_CODE.test(tokens[i + 1] ?? "")) value = `${value} ${tokens[++i]}`;
      const k = key as keyof SearchFlags;
      const prev = f[k];
      (f as Record<string, unknown>)[k] = prev == null ? value : [...(Array.isArray(prev) ? prev : [String(prev)]), value];
      continue;
    }
    if (quoted.has(tok)) {
      flushPhrase();
      keywords.push(tok);
    } else {
      phrase.push(tok);
    }
  }
  flushPhrase();

  const merged: SearchFlags & { onsite?: boolean } = { ...f, ...flags };
  const locations: Array<{ city: string | null; country: string | null }> = [];
  let remote: SearchQuery["remote"] = "any";
  for (const l of list(merged.loc, /;/)) {
    const p = parseLoc(l);
    if (p === "remote") remote = "only";
    else locations.push(p);
  }
  for (const c of list(merged.country)) if (/^[A-Za-z]{2}$/.test(c)) locations.push({ city: null, country: c.toUpperCase() });
  if (merged.remote === true || merged.remote === "only") remote = "only";
  else if (merged.remote === "exclude" || merged.onsite) remote = "exclude";
  else if (merged.remote === false) remote = "any";

  const seniority = list(merged.seniority)
    .map((s) => s.toLowerCase().replace(/[\s-]/g, ""))
    .map((s) => (LevelBandEnum.options as readonly string[]).includes(s) ? (s as LevelBand) : SENIORITY_WORDS[s])
    .filter((s): s is LevelBand => !!s);
  const sources = list(merged.sources)
    .map((s) => s.toLowerCase())
    .filter((s): s is SourceKind => (SourceKindEnum.options as readonly string[]).includes(s));
  const minSalary = merged.minSalary != null ? parseMoney(Array.isArray(merged.minSalary) ? merged.minSalary[0]! : merged.minSalary, merged.currency) : null;
  const posted = merged.posted != null ? parseDays(Array.isArray(merged.posted) ? String(merged.posted[0]) : merged.posted) : null;

  return SearchQuery.parse({
    keywords,
    titles: list(merged.title),
    mustSkills: list(merged.must),
    niceSkills: list(merged.nice),
    locations: dedupeLocs(locations),
    remote,
    remoteGeo: [] as Array<(typeof RemoteGeoEnum.options)[number]>,
    seniority: [...new Set(seniority)],
    minSalary,
    postedWithinDays: posted,
    sources: [...new Set(sources)],
    excludeCompanies: list(merged.excludeCompany),
    excludeKeywords: list(merged.exclude),
    presets: [...new Set(list(merged.preset).map((p) => p.toLowerCase()))],
  });
}

function dedupeLocs(locs: Array<{ city: string | null; country: string | null }>) {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${(l.city ?? "").toLowerCase()}|${l.country ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
