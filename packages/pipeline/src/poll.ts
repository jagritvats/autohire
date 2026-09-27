import { AtsType, SourceKind } from "@jobflow/core";
import { atsAdapter, fetchTelegramChannel, getAdapter, type FetchTarget } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { ingestCompany, ingestFromAdapter } from "./ingest.js";
import { resolveDiscoveredCompanies } from "./discover.js";
import { harvestLinks } from "./harvest.js";
import { localEmbedder, type Embedder } from "./embedder.js";
import { estimatePostingSalaries } from "./salary.js";

/**
 * One discovery feed = a cloud-safe board adapter + the searches to run on it. These
 * surface roles (and company names) outside the curated registry. Feeds are data, so
 * adding a source is one entry here plus its adapter — the poll loop never changes.
 */
export interface DiscoveryFeed {
  source: SourceKind;
  targets: FetchTarget[];
  /** rate-limited to minutes per request (Reddit) — skipped by request-bound refreshes. */
  slow?: boolean;
}

/**
 * Default feeds, biased to what's workable from India (§11.3) and to early-/mid-career
 * roles: sources are queried with their own geo + experience facets where they have
 * one (Himalayas country + seniority, Hirist min/max exp). That shapes what we poll —
 * ranking still scores every role (invariant #4). Arbeitnow is deliberately absent:
 * it's a German-market board (mostly German-language, EU-onsite roles).
 */
export const DEFAULT_DISCOVERY_FEEDS: DiscoveryFeed[] = [
  {
    source: "himalayas", // remote roles that explicitly name India as an allowed location
    targets: [
      { query: "backend", limit: 60, params: { country: "IN", seniority: "Entry-level,Mid-level" } },
      { query: "software engineer", limit: 40, params: { country: "IN", seniority: "Entry-level,Mid-level" } },
    ],
  },
  {
    source: "hirist", // India tech board; overlapping 1–4 yr experience band
    targets: [
      { query: "backend developer", limit: 60, params: { minexp: 1, maxexp: 4 } },
      { query: "java developer", limit: 40, params: { minexp: 1, maxexp: 4 } },
    ],
  },
  {
    source: "cutshort", // India startups; listing slugs are role × city
    targets: [
      { query: "backend-developer-jobs-in-bangalore-bengaluru", limit: 50 },
      { query: "backend-developer-jobs-in-pune", limit: 50 },
      { query: "backend-developer-jobs-in-hyderabad", limit: 50 },
    ],
  },
  {
    source: "timesjobs", // links go straight to the employer's own posting (board discovery)
    targets: [
      { query: "backend", limit: 60, params: { experience: 2 } },
      { query: "java", limit: 40, params: { experience: 2 } },
    ],
  },
  { source: "instahyre", targets: [{ limit: 40, params: { years: 2 } }] }, // product cos, ~2-yr band
  { source: "wellfound", targets: [{ query: "backend-engineer", limit: 120, params: { location: "india", maxPages: 4 } }] },
  { source: "reddit", slow: true, targets: [{ limit: 100, params: { subreddit: "developersIndia" } }] }, // monthly hiring thread
  { source: "remotive", targets: [{ query: "backend", limit: 60 }] },
  { source: "hn_whoishiring", targets: [{ query: "india", limit: 60 }, { query: "backend", limit: 60 }] },
  // key-gated search APIs: no-ops (no request) until their keys are set — docs/SETUP.md "Optional sources"
  {
    source: "adzuna", // broad India aggregator; same free keys as the salary enricher
    targets: [
      { query: "backend", limit: 50, params: { titleOnly: true, maxDaysOld: 14 } },
      { query: "software engineer", limit: 50, params: { titleOnly: true, maxDaysOld: 14 } },
    ],
  },
  { source: "careerjet", targets: [{ query: "backend developer", limit: 50 }, { query: "software engineer", limit: 50 }] }, // en_IN index
  {
    source: "jsearch", // PAID: each target is called at most once per JSEARCH_MIN_HOURS (default 24h)
    targets: [{ query: "backend developer", location: "India", limit: 50, params: { country: "in", datePosted: "week" } }],
  },
];

/**
 * Postings from non-board sources (aggregators, HN) have no per-company board to diff,
 * so `markStale` can't retire them. Anything not re-seen by its feed in this window is
 * soft-deleted (§3). Board postings are covered by markStale on every poll.
 */
export const FEED_TTL_DAYS = 14;

/**
 * Public Telegram channels harvested by default. Picked from a 2026-09 review of ~100
 * Indian job channels: these three post the most DIRECT company-board links for 1–4 YoE
 * engineers (54–72%), with no scams; gocareers is usually first, the others add a few
 * unique roles a day. Most large "freshers" channels route 90%+ of links through
 * ad-funded blogs and were left out. Only links are used — postings come from the board.
 */
export const DEFAULT_TELEGRAM_CHANNELS = ["gocareers", "techuprise_updates", "dot_aware"];
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
  /** ISO country for boards that filter server-side (default JOBFLOW_POLL_COUNTRY or IN). */
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
  feeds?: DiscoveryFeed[];
  /** max discovered company shells to resolve to ATS boards this run. */
  resolveMax?: number;
  /**
   * public Telegram channels to harvest for ATS/careers links (discovery only — see
   * harvest.ts). Default: JOBFLOW_TELEGRAM_CHANNELS when set (empty = off), else
   * DEFAULT_TELEGRAM_CHANNELS.
   */
  telegramChannels?: string[];
  /** skip feeds marked `slow` (a request-bound web refresh can't wait a minute per call). */
  skipSlowFeeds?: boolean;
  log?: (m: string) => void;
}

export interface PollStats {
  companiesPolled: number;
  fetched: number;
  staled: number;
  feeds: Record<string, number>;
  resolved: string[];
  expired: number;
  /** postings (re)priced by the offline salary estimator after the poll (§11.4) */
  salaryEstimated?: number;
  errors: string[];
}

/**
 * The single poll routine shared by the cron, the job runner and the web refresh:
 * boards due → discovery feeds → community links → resolve India-relevant shells →
 * expire postings nobody has re-confirmed. CLOUD-SAFE ONLY (invariant #1): feeds resolve
 * through the cloud registry (`getAdapter`), which never contains a Tier-3 adapter, and
 * the tier is re-checked.
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

  // 1. registered ATS boards (the rich, ghost-free spine)
  const companies = opts.companyId
    ? (await repo.listCompanies()).filter((c) => c.id === opts.companyId)
    : (await repo.listCompanies({ status: "active", dueForPoll: !opts.allCompanies }))
        // boards with no CLOUD adapter (Darwinbox & co. are local-agent only, invariant #1)
        // are polled by the agent; here they'd only burn the per-run board budget
        .filter((c) => c.atsType !== "unknown" && c.atsSlug && atsAdapter(c.atsType))
        .sort((a, b) => polledAt(a) - polledAt(b))
        .slice(0, opts.maxBoards ?? DEFAULT_MAX_BOARDS);
  for (const c of companies) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    const r = await ingestCompany(repo, c, { embedder, limit: opts.limitPerCompany, country: opts.country });
    stats.companiesPolled++;
    stats.fetched += r.fetched;
    stats.staled += r.staled;
    stats.errors.push(...r.errors);
  }
  log(`poll: ${stats.companiesPolled} boards, ${stats.fetched} postings, ${stats.staled} staled`);
  if (opts.companyId) return stats;

  // 2. discovery feeds (tier 1-2 only)
  for (const feed of (opts.feeds ?? DEFAULT_DISCOVERY_FEEDS).filter((f) => !(opts.skipSlowFeeds && f.slow))) {
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
    stats.feeds[feed.source] = n;
    stats.fetched += n;
    log(`  ${feed.source}: +${n}`);
  }

  // 2b. community channels → company boards (the posting itself comes from the board)
  const envChannels = process.env.JOBFLOW_TELEGRAM_CHANNELS;
  const channels = opts.telegramChannels ?? (envChannels != null ? csv(envChannels) : DEFAULT_TELEGRAM_CHANNELS);
  for (const channel of channels) {
    const msgs = await fetchTelegramChannel(channel, { pages: 2 });
    const h = await harvestLinks(repo, msgs, { origin: `telegram:${channel}` });
    stats.resolved.push(...h.boards);
    log(`  telegram/${channel}: ${msgs.length} msgs → ${h.boards.length} boards (${h.skippedSuspicious} suspicious skipped)`);
  }

  // 3. upgrade India-relevant company shells to their ATS boards (next poll hits them)
  const res = await resolveDiscoveredCompanies(repo, { max: opts.resolveMax });
  stats.resolved.push(...res.resolved);
  if (res.tried) log(`  resolved ${res.resolved.length}/${res.tried} discovered companies`);

  // 4. expire non-board postings their source stopped returning
  stats.expired = await repo.purgeOldPostings({ olderThanDays: FEED_TTL_DAYS, field: "lastSeen", sources: NON_BOARD_SOURCES });
  stats.expired += await repo.purgeOldPostings({ olderThanDays: BOARD_TTL_DAYS, field: "lastSeen" });
  if (stats.expired) log(`  expired ${stats.expired} postings unseen for ${FEED_TTL_DAYS}d (feeds) / ${BOARD_TTL_DAYS}d (boards)`);

  return stats;
}

const DEFAULT_MAX_BOARDS = 80;

/** never-polled boards first (0), then oldest poll first */
function polledAt(c: { lastPolled: string | Date | null }): number {
  return c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0;
}

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}
