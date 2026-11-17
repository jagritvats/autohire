import { AtsType, SourceKind, normCompany, type Company } from "@jobflow/core";
import { atsAdapter, atsLinksFromRaws, fetchTelegramChannel, getAdapter, takeFeedError } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { ingestCompany, ingestFromAdapter } from "./ingest.js";
import { DEFAULT_CONCURRENCY, discoverCompanies, mapPoolKeyed, resolveDiscoveredCompanies, type SeedCompany } from "./discover.js";
import { harvestLinks } from "./harvest.js";
import { localEmbedder, type Embedder } from "./embedder.js";
import { estimatePostingSalaries } from "./salary.js";
import { resolveDiscoveryPlan, type CustomSourceTarget, type DiscoveryPlan, type SearchTarget } from "./discovery.js";
import type { DiscoveryFeed } from "./presets/types.js";

// The feed/channel lists now live in the `india` preset (presets/india.ts) — re-exported
// here so existing importers keep working.
export type { DiscoveryFeed } from "./presets/types.js";
export { DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "./presets/india.js";

/**
 * Postings from non-board sources (aggregators, HN) have no per-company board to diff,
 * so `markStale` can't retire them. Anything not re-seen by its feed in this window is
 * soft-deleted (§3). Board postings are covered by markStale on every poll.
 */
export const FEED_TTL_DAYS = 14;

/**
 * Any posting unseen this long is gone or unpollable (company paused/removed, board
 * emptied — an empty fetch never mass-stales, since it can't be told from an error).
 * Active boards are polled at least every 6 days, so this never catches a live one.
 */
export const BOARD_TTL_DAYS = 21;

/** every source that is not a company ATS board — incl. ones no longer in the feed list. */
export const NON_BOARD_SOURCES: SourceKind[] = SourceKind.options.filter(
  (s) => !(AtsType.options as readonly string[]).includes(s),
);

export interface PollOptions {
  embedder?: Embedder;
  /** poll just this company (skips discovery feeds, resolution and the TTL sweep). */
  companyId?: string;
  /**
   * ISO country for boards that filter server-side. Default: the discovery plan's
   * `pollCountries` (JOBFLOW_POLL_COUNTRY → tenants' markets → preset markets → IN); a
   * multi-market plan polls country-filtered boards once per country.
   */
  country?: string;
  /** cap upserts per board (embedding cost); the fetch is always the full board. */
  limitPerCompany?: number;
  /** poll every active company, not just those due by cadence. */
  allCompanies?: boolean;
  /**
   * max boards per run, least-recently-polled first (default 80). The registry holds
   * hundreds of boards; bounding each run spreads the first sweep (and any backlog)
   * over several runs instead of one hour-long burst against the same hosts.
   */
  maxBoards?: number;
  /** discovery feeds to run. Default: the plan's (the tenants' presets — `india` by default). */
  feeds?: DiscoveryFeed[];
  /** max discovered company shells to resolve to ATS boards this run. */
  resolveMax?: number;
  /**
   * public Telegram channels to harvest for ATS/careers links (discovery only — see
   * harvest.ts). Default: JOBFLOW_TELEGRAM_CHANNELS when set (empty = off), else the plan's
   * (preset channels + custom Telegram sources).
   */
  telegramChannels?: string[];
  /** skip feeds marked `slow` (a request-bound web refresh can't wait a minute per call). */
  skipSlowFeeds?: boolean;
  /** a precomputed plan (else resolved from the repo). */
  plan?: DiscoveryPlan;
  /** run custom RSS/JSON/HN-thread sources (default true). */
  customSources?: boolean;
  /** run due saved searches against search-capable sources (default true). */
  searches?: boolean;
  /**
   * register plan seed employers that aren't in the registry yet — a newly chosen preset,
   * a custom company list (default true). Known companies are never re-probed here.
   */
  discoverNewSeeds?: boolean;
  /** boards polled at once (default 8; ≤2 per host — politeness). */
  concurrency?: number;
  log?: (m: string) => void;
}

export interface PollStats {
  companiesPolled: number;
  fetched: number;
  staled: number;
  feeds: Record<string, number>;
  resolved: string[];
  expired: number;
  /** postings fetched per custom source configKey */
  custom?: Record<string, number>;
  /** postings fetched per saved search id */
  searches?: Record<string, number>;
  /** postings (re)priced by the offline salary estimator after the poll (§11.4) */
  salaryEstimated?: number;
  errors: string[];
}

/**
 * The single poll routine shared by the cron, the job runner and the web refresh:
 * boards due → discovery feeds → custom sources → saved searches → community links →
 * resolve relevant shells → expire postings nobody has re-confirmed. CLOUD-SAFE ONLY
 * (invariant #1): every source resolves through the cloud registry (`getAdapter` /
 * the plan's `cloudAdapter`), which never contains a Tier-3 adapter, and the tier is
 * re-checked.
 */
export async function pollAll(repo: Repository, opts: PollOptions = {}): Promise<PollStats> {
  const stats = await pollSources(repo, opts);
  // offline + cheap: re-price every posting that states no pay against the refreshed
  // corpus, so estimates track new comparables without waiting for an enrich run (§11.4).
  // Never fails the poll.
  try {
    stats.salaryEstimated = (await estimatePostingSalaries(repo)).estimated;
  } catch (e) {
    stats.errors.push(`salary estimate: ${(e as Error).message}`);
  }
  return stats;
}

async function pollSources(repo: Repository, opts: PollOptions): Promise<PollStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const log = opts.log ?? (() => {});
  const stats: PollStats = { companiesPolled: 0, fetched: 0, staled: 0, feeds: {}, resolved: [], expired: 0, errors: [] };

  // what to poll: explicit options win; everything else comes from the tenants' plan
  let plan = opts.plan;
  if (!plan) {
    try {
      plan = await resolveDiscoveryPlan(repo);
    } catch (e) {
      stats.errors.push(`discovery plan: ${(e as Error).message}`);
    }
  }
  const countries = opts.country ? [opts.country] : (plan?.pollCountries ?? []);

  // 0. seed employers new to the registry (first run, a newly switched-on preset, a custom
  //    company list) are resolved to boards FIRST, so this same run polls them — otherwise a
  //    fresh install's first sync polls zero boards and only feeds
  if (plan && opts.discoverNewSeeds !== false && !opts.companyId) {
    const fresh: SeedCompany[] = [];
    for (const s of plan.seeds) {
      const c = await repo.findCompanyByNameNorm(normCompany(s.name));
      if (!c) fresh.push(s);
    }
    if (fresh.length) {
      try {
        const d = await discoverCompanies(repo, fresh, { markets: plan.pollCountries });
        log(`  seeds: ${fresh.length} new → ${d.resolved} boards`);
      } catch (e) {
        stats.errors.push(`seed discovery: ${(e as Error).message}`);
      }
    }
    for (const id of plan.companyListSourceIds) {
      await repo.recordDiscoverySourceRun(id, { status: "ok", count: fresh.length }).catch(() => {});
    }
  }

  // 1. registered ATS boards (the rich, ghost-free spine) — pooled across hosts
  const companies = opts.companyId
    ? (await repo.listCompanies()).filter((c) => c.id === opts.companyId)
    : (await repo.listCompanies({ status: "active", dueForPoll: !opts.allCompanies }))
        // boards with no CLOUD adapter (Darwinbox & co. are local-agent only, invariant #1)
        // are polled by the agent; here they'd only burn the per-run board budget
        .filter((c) => c.atsType !== "unknown" && c.atsSlug && atsAdapter(c.atsType))
        .sort((a, b) => polledAt(a) - polledAt(b))
        .slice(0, opts.maxBoards ?? DEFAULT_MAX_BOARDS);
  await mapPoolKeyed(
    companies,
    { concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY, perKey: 2, key: boardHostKey },
    async (c) => {
      if (c.atsType === "unknown" || !c.atsSlug) return;
      try {
        const r = await ingestCompany(repo, c, {
          embedder,
          limit: opts.limitPerCompany,
          ...(countries.length > 1 ? { countries } : { country: countries[0] }),
        });
        stats.companiesPolled++;
        stats.fetched += r.fetched;
        stats.staled += r.staled;
        stats.errors.push(...r.errors);
      } catch (e) {
        stats.errors.push(`${c.name}: ${(e as Error).message}`);
      }
    },
  );
  log(`poll: ${stats.companiesPolled} boards, ${stats.fetched} postings, ${stats.staled} staled`);
  if (opts.companyId) return stats;

  // 2. discovery feeds (tier 1-2 only)
  const feeds = opts.feeds ?? plan?.feeds ?? [];
  for (const feed of feeds.filter((f) => !(opts.skipSlowFeeds && f.slow))) {
    const adapter = getAdapter(feed.source);
    if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) {
      stats.errors.push(`feed ${feed.source}: not a registered cloud adapter`);
      continue;
    }
    let n = 0;
    for (const target of feed.targets) {
      const r = await ingestFromAdapter(repo, adapter, target, { embedder });
      n += r.fetched;
      stats.errors.push(...r.errors);
    }
    stats.feeds[feed.source] = (stats.feeds[feed.source] ?? 0) + n;
    stats.fetched += n;
    log(`  ${feed.source}: +${n}`);
  }

  // 2a. custom sources (RSS / JSON feeds / HN threads) — each run recorded on its rows
  if (plan && opts.customSources !== false) {
    stats.custom = {};
    for (const t of [...plan.rssTargets, ...plan.jsonTargets, ...plan.threads]) {
      const n = await runCustomSource(repo, t, embedder, stats);
      stats.custom[t.configKey] = n;
      stats.fetched += n;
    }
    if (plan.rssTargets.length + plan.jsonTargets.length + plan.threads.length) {
      log(`  custom sources: +${Object.values(stats.custom).reduce((a, b) => a + b, 0)}`);
    }
  }

  // 2b. due saved searches → search-capable sources (ingested like any feed — idempotent)
  if (plan && opts.searches !== false && plan.searchTargets.length) {
    stats.searches = await runSearchTargets(repo, plan.searchTargets, embedder, stats);
    log(`  saved searches: ${Object.keys(stats.searches).length} run`);
  }

  // 2c. community channels → company boards (the posting itself comes from the board)
  const envChannels = process.env.JOBFLOW_TELEGRAM_CHANNELS;
  const channels = opts.telegramChannels ?? (envChannels != null ? csv(envChannels) : (plan?.telegramChannels ?? []));
  for (const channel of channels) {
    const msgs = await fetchTelegramChannel(channel, { pages: 2 });
    const h = await harvestLinks(repo, msgs, { origin: `telegram:${channel}` });
    stats.resolved.push(...h.boards);
    log(`  telegram/${channel}: ${msgs.length} msgs → ${h.boards.length} boards (${h.skippedSuspicious} suspicious skipped)`);
  }

  // 3. upgrade market-relevant company shells to their ATS boards (next poll hits them)
  const res = await resolveDiscoveredCompanies(repo, { max: opts.resolveMax, markets: countries.length ? countries : undefined });
  stats.resolved.push(...res.resolved);
  if (res.tried) log(`  resolved ${res.resolved.length}/${res.tried} discovered companies`);

  // 4. expire non-board postings their source stopped returning
  stats.expired = await repo.purgeOldPostings({ olderThanDays: FEED_TTL_DAYS, field: "lastSeen", sources: NON_BOARD_SOURCES });
  stats.expired += await repo.purgeOldPostings({ olderThanDays: BOARD_TTL_DAYS, field: "lastSeen" });
  if (stats.expired) log(`  expired ${stats.expired} postings unseen for ${FEED_TTL_DAYS}d (feeds) / ${BOARD_TTL_DAYS}d (boards)`);

  return stats;
}

/** one custom source: ingest (SSRF-guarded fetch inside the adapter), record the run, harvest ATS links. */
async function runCustomSource(repo: Repository, t: CustomSourceTarget, embedder: Embedder, stats: PollStats): Promise<number> {
  const adapter = getAdapter(t.source);
  let fetched = 0;
  let error: string | null = null;
  if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) {
    error = `${t.source}: not a registered cloud adapter`;
  } else {
    let atsLinks: string[] = [];
    const r = await ingestFromAdapter(repo, adapter, t.target, {
      embedder,
      onRaws: (raws) => {
        atsLinks = atsLinksFromRaws(raws).slice(0, MAX_HARVEST_PER_FEED);
      },
    });
    fetched = r.fetched;
    stats.errors.push(...r.errors);
    const feedKey = String(t.target.params?.feedKey ?? "");
    error = (feedKey ? takeFeedError(feedKey) : null) ?? r.errors[0] ?? null;
    // an item that links to an employer's own ATS also discovers that employer's board
    if (atsLinks.length) {
      const h = await harvestLinks(
        repo,
        atsLinks.map((text) => ({ text, postedAt: null })),
        { origin: `${t.source}:${feedKey || t.configKey.slice(0, 12)}` },
      ).catch(() => null);
      if (h) stats.resolved.push(...h.boards);
    }
  }
  if (error) stats.errors.push(`custom ${t.source}: ${error}`);
  const status = error ? "error" : fetched ? "ok" : "empty";
  for (const id of t.sourceIds) {
    await repo.recordDiscoverySourceRun(id, { status, count: fetched, error }).catch(() => {});
  }
  return fetched;
}

/** run the plan's search targets; returns fetched counts per saved-search id (and records each run). */
export async function runSearchTargets(
  repo: Repository,
  targets: SearchTarget[],
  embedder: Embedder,
  stats?: Pick<PollStats, "fetched" | "errors">,
): Promise<Record<string, number>> {
  const perSearch: Record<string, number> = {};
  const owners = new Map<string, string>();
  const sourcesBySearch = new Map<string, Record<string, number>>();
  for (const st of targets) {
    const adapter = getAdapter(st.source);
    if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) continue; // invariant #1
    const r = await ingestFromAdapter(repo, adapter, st.target, { embedder });
    if (stats) {
      stats.fetched += r.fetched;
      stats.errors.push(...r.errors);
    }
    for (const s of st.searches) {
      owners.set(s.searchId, s.tenantId);
      perSearch[s.searchId] = (perSearch[s.searchId] ?? 0) + r.fetched;
      const bySource = sourcesBySearch.get(s.searchId) ?? {};
      bySource[st.source] = (bySource[st.source] ?? 0) + r.fetched;
      sourcesBySearch.set(s.searchId, bySource);
    }
  }
  for (const [searchId, tenantId] of owners) {
    await repo
      .recordSavedSearchRun(tenantId, searchId, { fetched: perSearch[searchId] ?? 0, sources: sourcesBySearch.get(searchId) ?? {}, via: "poll" })
      .catch(() => {});
  }
  return perSearch;
}

const DEFAULT_MAX_BOARDS = 80;
/** ATS links harvested from one custom feed per run (one detector probe each). */
const MAX_HARVEST_PER_FEED = 10;

/** never-polled boards first (0), then oldest poll first */
function polledAt(c: { lastPolled: string | Date | null }): number {
  return c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0;
}

/**
 * The host a board is served from, for per-host politeness: multi-tenant hosts
 * (Workday "{host}/{tenant}/{site}", Eightfold "{host}/{domain}") by their host, shared
 * APIs (Greenhouse, Lever, Ashby…) by ATS.
 */
function boardHostKey(c: Company): string {
  const first = (c.atsSlug ?? "").split("/")[0] ?? "";
  return first.includes(".") ? first.toLowerCase() : c.atsType;
}

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}
