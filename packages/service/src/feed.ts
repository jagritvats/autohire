import { InMemoryRepository, type PurgeOptions, type Repository } from "@jobflow/db";
import {
  blankProfile,
  isOnboarded,
  loadFxRates,
  presetsForPosting,
  pollAll,
  pollBacklog,
  rebuildMatches,
  recheckPostings,
  syncLimitsFromEnv,
  type PollOptions,
  type PollStats,
  type RecheckStats,
} from "@jobflow/pipeline";
import type { Match, Posting, SearchQueryInput, ViewHiddenReason } from "@jobflow/core";
import { applyView, companyDisplayName, describeLocation, describePay, diversifyByCompany, diversifyKey, payDisplayOptions, postingAgeDays, scoreSourceTrust, workableFor, type FormatPayOptions, type ProfilePrefs } from "@jobflow/core";
import { ensureTenant } from "./tenant.js";
import { corpusEmbedder } from "./embedder.js";
import { corpusSyncing, startCorpusSync } from "./sync.js";

/** Serializable match-card DTO for the client UI (§11.6). */
export interface FeedCard {
  id: string;
  companyId: string;
  title: string;
  company: string;
  score: number;
  archetype: string;
  source: string;
  tier: string;
  ats: string;
  ageDays: number;
  atsDirect: boolean;
  /**
   * `label` is the whole plain-language line every surface shows as is ("Remote · worldwide",
   * "Hybrid · München, Germany", "Onsite · Bengaluru, India + Singapore"); `places` lists
   * every place for the Job page. `country` is the primary country's name (never the
   * legacy region "Europe" when the country is known); `countries` are ISO-2 codes.
   */
  location: {
    mode: string;
    label: string;
    place: string;
    places: string[];
    remoteGeo: string;
    country: string | null;
    countries: string[];
    confidence: number;
  };
  /** parsed years-of-experience the JD asks for (§11.2); nulls when unstated. */
  experience: { min: number | null; max: number | null; fit: "ok" | "stretch" | "far" | null };
  /**
   * workable for THIS user: an office in their home country or a market, or a remote role
   * open to where they live / a region they can work from. null = can't tell (no home or
   * markets set, or the posting's place is unknown). Region-neutral; a view signal only.
   */
  workable: boolean | null;
  /** posted by a staffing agency / third-party recruiter, not the employer */
  agency: boolean;
  /** the employer is an IT-services / outsourcing firm (company tagged "services"). */
  services: boolean;
  /** source trust 0..1 (§11): source prior × listing signals — real, open, answered. */
  trust: number;
  level: string | null;
  levelNote: string | null;
  stackNote: string | null;
  skills: string[];
  /**
   * Pay: what the posting states, else our estimate (§11.4), formatted ONCE by core's
   * `describePay` in the reader's "show pay in" currency and period: "₹30L–45L / yr (≈ $32k–48k)".
   * `estimate` is never blurred; a low-confidence one is a single "rough est. ~…" figure.
   */
  comp: {
    label: string;
    confidence: string;
    source: string;
    estimate: boolean;
    /** 0..1, estimates only */
    confidenceScore: number | null;
    /** estimates only: "14 similar posted ranges in India (5 same level) · levels.fyi …" */
    basis: string | null;
    /** a low-confidence estimate shown as one rough figure */
    rough?: boolean;
    /** "annualised from hourly" */
    note?: string | null;
    /** the stated currency disagrees with the role's location (also in redFlags) */
    warning?: string | null;
    /** FX rate date when the label converts a figure */
    rateDate?: string | null;
  } | null;
  rating: { overall: number; reviews: number } | null;
  redFlags: string[];
  applyUrl: string | null;
  /** don't-double-apply: true if this company+role is already in the CRM (§7). */
  applied: boolean;
  /** per-user overlay (tenant-scoped): bookmarked / archived by this tenant. */
  bookmarked: boolean;
  archived: boolean;
  /** global manual lifecycle: invalidated (spam/dupe/fake) + why. */
  invalidated: boolean;
  invalidReason: string | null;
  /** discovery-preset tags (india / us / eu-uk / global-remote) — filterable in the feed */
  presets: string[];
}

export interface FeedData {
  cards: FeedCard[];
  stats: {
    companies: number;
    postings: number;
    ranked: number;
    excluded: number;
    durable: boolean;
    /** offline fictional demo corpus (JOBFLOW_DEMO_DATA=1) */
    demo?: boolean;
    generatedAt: string;
    /** most recent board poll (ISO) — the UI warns when the corpus has gone unverified. */
    lastPolledAt: string | null;
    /** "ranked" = scored against the profile; "browse" = unscored (not onboarded yet). */
    mode: "ranked" | "browse";
    needsOnboarding: boolean;
    /** a background corpus sync is running in this process. */
    syncing: boolean;
    /** when a view was applied: how many cards it hid, per reason (never silent). */
    hidden?: Record<ViewHiddenReason, number>;
    hiddenTotal?: number;
  };
}

/** The secondary views (per-user / lifecycle collections), rendered as feed cards. */
export type PostingView = "bookmarks" | "archived" | "invalidated";

/** Options for reading a tenant's feed. */
export interface FeedOptions {
  /** soft VIEW filter (never a hard exclusion, invariant #4): only roles workable for you (`FeedCard.workable`). */
  workableOnly?: boolean;
  /**
   * a saved search (by id) or an ad-hoc query applied as a VIEW: it hides only on
   * confidently-known values, never rescores, and the hidden counts are returned.
   */
  view?: string | SearchQueryInput | null;
  limit?: number;
  /**
   * spread the page across employers (default true): at most 3 cards per company in any 20,
   * the rest following later (`diversifyByCompany`). Order only — no score changes, nothing
   * hidden (invariant #4). false = pure score order (`--no-diversify`, "score order only").
   */
  diversify?: boolean;
  /**
   * when the shared corpus is empty, start ONE background sync (deduped across requests)
   * and return immediately instead of polling inside the request. Default true; multi-user
   * deployments leave syncing to the worker and pass false.
   */
  bootstrap?: boolean;
}

/** What one sync polls: `full` (every due board and slow feed, no time box) or the default sweep. */
export interface SyncOptions {
  full?: boolean;
  /** a fixed board cap for this sync (the CLI's `--max-boards`); else `JOBFLOW_SYNC_MAX_BOARDS`, else every due board */
  maxBoards?: number;
  /** a tighter board-fetch time budget (a request-bound refresh); else `JOBFLOW_SYNC_MINUTES`, else 5 min */
  timeBudgetMs?: number;
  log?: (m: string) => void;
  /** structured progress events (the sync run manager folds them into SyncProgress) */
  onProgress?: PollOptions["onProgress"];
  /** cancel: stop starting boards/feeds; nothing is retired from the partial run */
  signal?: AbortSignal;
}

/**
 * Board-fetch time budget of the default sweep (`JOBFLOW_SYNC_MINUTES` overrides). Every DUE
 * board is polled — the budget scales with the registry and its cadences — but a run stops
 * starting new boards after this long, so a backlog (a fresh 240-board registry, a weekly
 * cohort coming due together) spreads over the next runs instead of one long sync.
 */
export const SYNC_TIME_BUDGET_MS = 5 * 60_000;

/**
 * The pollAll options of one sync — shared by the web's background sync, `jobflow sync` and
 * the MCP `sync` tool so they can't drift. The default sweep caps postings per board
 * (embedding cost) and skips slow feeds; boards: every due one, most overdue first, inside
 * the time budget, except a fresh registry's first sync, which stops at 25 boards / 90 s so
 * the first feed comes fast (`pollAll`'s "auto"). `full` drops every bound.
 */
export function syncPollOptions(opts: SyncOptions = {}): PollOptions {
  const log = {
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (opts.full) return { embedder: corpusEmbedder(), maxBoards: opts.maxBoards ?? Infinity, timeBudgetMs: Infinity, ...log };
  const env = syncLimitsFromEnv();
  return {
    embedder: corpusEmbedder(),
    limitPerCompany: 50,
    maxBoards: opts.maxBoards ?? env.maxBoards ?? "auto",
    timeBudgetMs: opts.timeBudgetMs ?? env.timeBudgetMs ?? SYNC_TIME_BUDGET_MS,
    skipSlowFeeds: true,
    telegramChannels: [],
    ...log,
  };
}

/** discover seeds + poll boards/feeds — bounded, the same routine the worker runs. */
export async function syncCorpus(repo: Repository, opts: SyncOptions = {}): Promise<PollStats> {
  // the discovery plan (each tenant's preset + custom sources + saved searches) decides
  // WHAT is polled; `syncPollOptions` decides how much of it this run takes
  return pollAll(repo, syncPollOptions(opts));
}

/**
 * Does the local schedule owe the registry a catch-up sync? True while boards have never
 * been polled — the first sync is capped and a time-boxed one can stop short — so the web
 * app keeps syncing every quarter-hour until the whole registry has had its first poll,
 * instead of leaving most of it for the next 6-hour run.
 */
export async function needsCatchUpSync(repo: Repository): Promise<boolean> {
  return (await pollBacklog(repo)).neverPolled > 0;
}

/**
 * Rank the shared corpus for one tenant. Never ranks against an empty, un-onboarded
 * profile — there is no candidate to score yet, so any score would be invented.
 */
export async function rankTenant(repo: Repository, tenantId: string): Promise<boolean> {
  const profile = await repo.getProfile(tenantId);
  if (!profile || !isOnboarded(profile)) return false;
  await rebuildMatches(repo, profile, { embedder: corpusEmbedder() });
  return true;
}

/**
 * Read the tenant's feed. Before onboarding it's a BROWSE feed — the freshest, most
 * trustworthy postings, unscored — so a new user sees real jobs without fake fit scores.
 */
export async function getFeed(repo: Repository, tenantId: string, opts: FeedOptions = {}): Promise<FeedData> {
  await ensureTenant(repo, tenantId);
  const limit = opts.limit ?? 80;
  const profile = await repo.getProfile(tenantId);
  const onboarded = isOnboarded(profile);
  const spread = opts.diversify !== false;
  if (!onboarded) {
    const browse = await browsePostings(repo, limit);
    if (browse.length === 0 && opts.bootstrap !== false) void startCorpusSync(repo, undefined, undefined, { trigger: "first_run" });
    return shapeBrowse(repo, tenantId, spread ? diversifyByCompany(browse, (p) => diversifyKey(p.companyName)) : browse);
  }
  let matches = await repo.listMatches(tenantId, limit);
  if (matches.length === 0 && opts.bootstrap !== false) {
    const corpus = await repo.listActivePostings();
    if (corpus.length === 0) void startCorpusSync(repo, async () => void (await rankTenant(repo, tenantId)), undefined, { trigger: "first_run" });
    else {
      await rankTenant(repo, tenantId);
      matches = await repo.listMatches(tenantId, limit);
    }
  }
  if (opts.workableOnly && profile) matches = matches.filter((m) => workableFor(m.posting.location, profile.prefs) !== false);
  // the spread runs on what is SHOWN (after the view), so its windows are the page's
  const order = (ms: typeof matches) => (spread ? diversifyByCompany(ms, (m) => diversifyKey(m.posting.companyName), { scoreOf: (m) => m.score }) : ms);
  if (opts.view) {
    const query = typeof opts.view === "string" ? (await repo.getSavedSearch(tenantId, opts.view))?.query : opts.view;
    if (query) {
      const v = applyView(matches, query, { presetsOf: presetsForPosting });
      const data = await shape(repo, tenantId, order(v.shown));
      return { ...data, stats: { ...data.stats, hidden: v.hidden, hiddenTotal: v.hiddenTotal } };
    }
  }
  return shape(repo, tenantId, order(matches));
}

/** Cards for arbitrary postings (+ optional scores) — e.g. ad-hoc search results. */
export async function toCards(
  repo: Repository,
  tenantId: string,
  items: Array<{ posting: Posting; match: Pick<Match, "score" | "levelNote" | "stackNote" | "redFlags"> | null }>,
): Promise<FeedCard[]> {
  const ctx = await cardCtx(repo, tenantId);
  return items.map((i) => buildCard(i.posting, i.match, ctx));
}

/** Force a fresh poll of the live Tier 1-2 sources + re-rank, then return the feed. */
export async function refreshFeed(repo: Repository, tenantId: string): Promise<FeedData> {
  await ensureTenant(repo, tenantId);
  // request-bound (the route allows 120 s): boards it doesn't reach lead the next sync
  await syncCorpus(repo, { timeBudgetMs: 60_000 });
  await rankTenant(repo, tenantId);
  return getFeed(repo, tenantId, { bootstrap: false });
}

/** Re-rank only (after a settings change) — no re-poll. */
export async function rerankOnly(repo: Repository, tenantId: string): Promise<FeedData> {
  await rankTenant(repo, tenantId);
  return getFeed(repo, tenantId, { bootstrap: false });
}

/** freshest × most trustworthy active postings — the pre-onboarding browse feed. */
async function browsePostings(repo: Repository, limit: number): Promise<Posting[]> {
  const all = await repo.listActivePostings();
  const key = (p: Posting) => scoreSourceTrust(p).score / (1 + postingAgeDays(p) / 14);
  return all
    .filter((p) => p.status === "active" && !p.canonicalId)
    .sort((a, b) => key(b) - key(a))
    .slice(0, limit);
}

async function shapeBrowse(repo: Repository, tenantId: string, postings: Posting[]): Promise<FeedData> {
  const data = await shape(repo, tenantId, []);
  const ctx = await cardCtx(repo, tenantId);
  return {
    cards: postings.map((p) => buildCard(p, null, ctx)),
    stats: { ...data.stats, ranked: 0, mode: "browse", needsOnboarding: true },
  };
}

/** Card context — the per-user overlays needed to render correct action state. */
interface CardCtx {
  /** the profile's years of experience — to mark how far the JD's ask is (null before
   *  onboarding: there's no candidate to compare with yet). */
  yoe: number | null;
  appliedKeys: Set<string>;
  bookmarked: Set<string>;
  archived: Set<string>;
  /** companies tagged "services" (IT-services / outsourcing employers). */
  servicesCompanyIds: Set<string>;
  /** the onboarded profile's region prefs — for `workable` (null before onboarding) */
  prefs: ProfilePrefs | null;
  /** how this reader wants pay shown ("show pay in" currency + per year/month) */
  pay: Pick<FormatPayOptions, "currency" | "period">;
}

/** Everything `buildCard` needs beyond the posting, loaded once per request. */
async function cardCtx(repo: Repository, tenantId: string, companies?: Awaited<ReturnType<Repository["listCompanies"]>>): Promise<CardCtx> {
  const [appliedKeys, userState, profile, cos] = await Promise.all([
    repo.appliedDedupKeys(tenantId),
    repo.getPostingUserState(tenantId),
    repo.getProfile(tenantId),
    companies ?? repo.listCompanies(),
    // the store's cached FX table (refreshed by syncs), so "≈" figures use the newest rate
    loadFxRates(repo).catch(() => null),
  ]);
  return {
    yoe: isOnboarded(profile) ? (profile ?? blankProfile(tenantId)).yoe : null,
    appliedKeys,
    bookmarked: userState.bookmarked,
    archived: userState.archived,
    servicesCompanyIds: new Set(cos.filter((c) => c.tags.includes("services")).map((c) => c.id)),
    prefs: isOnboarded(profile) && profile ? profile.prefs : null,
    pay: payDisplayOptions(profile?.prefs),
  };
}

/** Build one card from a posting + its (optional) match. Single source of card shape. */
function buildCard(
  p: Posting,
  m: Pick<Match, "score" | "levelNote" | "stackNote" | "redFlags"> | null,
  ctx: CardCtx,
): FeedCard {
  const ageDays = Math.floor(postingAgeDays(p)); // source publish date, else first seen
  const where = describeLocation(p.location);
  const trust = scoreSourceTrust(p);
  const comp = compLabel(p, ctx);
  return {
    id: p.id,
    companyId: p.companyId,
    title: p.title,
    company: companyDisplayName(p.companyName),
    score: m?.score ?? 0,
    archetype: p.roleArchetype,
    source: p.source,
    tier: p.tier,
    ats: p.atsType,
    ageDays,
    atsDirect: p.atsType !== "unknown",
    location: {
      mode: p.location.mode,
      label: where.label,
      place: where.place,
      places: where.places,
      remoteGeo: p.location.remoteGeo,
      country: where.country,
      countries: where.countries,
      confidence: p.location.confidence,
    },
    experience: { min: p.experience.min, max: p.experience.max, fit: experienceFit(p.experience.min, ctx.yoe) },
    workable: ctx.prefs ? workableFor(p.location, ctx.prefs) : null,
    agency: trust.agency,
    services: ctx.servicesCompanyIds.has(p.companyId),
    trust: Math.round(trust.score * 100) / 100,
    level: p.levelBand,
    levelNote: m?.levelNote ?? null,
    stackNote: m?.stackNote ?? null,
    skills: p.jdSkills.slice(0, 10),
    comp,
    rating: ratingOf(p),
    redFlags: comp?.warning ? [...(m?.redFlags ?? []), comp.warning] : (m?.redFlags ?? []),
    applyUrl: p.applyUrl,
    applied: ctx.appliedKeys.has(p.dedupKey),
    bookmarked: ctx.bookmarked.has(p.id),
    archived: ctx.archived.has(p.id),
    invalidated: p.status === "invalidated",
    invalidReason: p.invalidReason ?? null,
    presets: presetsForPosting(p),
  };
}

async function shape(repo: Repository, tenantId: string, matches: Awaited<ReturnType<Repository["listMatches"]>>): Promise<FeedData> {
  const companies = await repo.listCompanies();
  const ctx = await cardCtx(repo, tenantId, companies);
  const cards: FeedCard[] = matches.map((m) => buildCard(m.posting, m, ctx));
  const allActive = await repo.listActivePostings();
  const polled = companies.map((c) => (c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0));
  const lastPolled = Math.max(0, ...polled);
  return {
    cards,
    stats: {
      companies: companies.length,
      postings: allActive.length,
      ranked: cards.length,
      excluded: 0,
      // what the store actually is, not a guess from env vars (the web defaults to PGlite)
      durable: !(repo instanceof InMemoryRepository),
      demo: process.env.JOBFLOW_DEMO_DATA === "1",
      generatedAt: new Date().toISOString(),
      lastPolledAt: lastPolled ? new Date(lastPolled).toISOString() : null,
      mode: "ranked",
      needsOnboarding: false,
      syncing: corpusSyncing(),
    },
  };
}

/** A secondary collection (bookmarks / archived / invalidated), shaped as feed cards. */
export async function getPostingsView(repo: Repository, tenantId: string, view: PostingView): Promise<{ cards: FeedCard[]; view: PostingView }> {
  await ensureTenant(repo, tenantId);
  const ctx = await cardCtx(repo, tenantId);

  const postings =
    view === "bookmarks"
      ? await repo.listBookmarkedPostings(tenantId)
      : view === "archived"
        ? await repo.listArchivedPostings(tenantId)
        : await repo.listInvalidatedPostings();

  const matches = await repo.listMatchesForPostings(tenantId, postings.map((p) => p.id));
  const byPosting = new Map(matches.map((m) => [m.postingId, m]));
  const cards = postings
    .map((p) => buildCard(p, byPosting.get(p.id) ?? null, ctx))
    .sort((a, b) => b.score - a.score);
  return { cards, view };
}

/** Mass recheck a set of postings (re-poll their boards) + re-rank, then return the feed. */
export async function recheckFeed(repo: Repository, tenantId: string, postingIds: string[]): Promise<FeedData & { recheck: RecheckStats }> {
  await ensureTenant(repo, tenantId);
  const recheck = await recheckPostings(repo, postingIds, { limit: 50, embedder: corpusEmbedder() });
  await rankTenant(repo, tenantId);
  return { ...(await getFeed(repo, tenantId, { bootstrap: false })), recheck };
}

/** Bulk soft-delete / hard-purge postings older than a threshold; return the fresh feed. */
export async function purgeOldFeed(repo: Repository, tenantId: string, opts: PurgeOptions): Promise<FeedData & { purged: number }> {
  await ensureTenant(repo, tenantId);
  const purged = await repo.purgeOldPostings(opts);
  const matches = await repo.listMatches(tenantId, 80);
  return { ...(await shape(repo, tenantId, matches)), purged };
}

/** The card's pay — core's one formatter, in this reader's display currency + period. */
function compLabel(p: Posting, ctx: Pick<CardCtx, "pay">): FeedCard["comp"] {
  return describePay(p, ctx.pay);
}

function ratingOf(p: Posting): { overall: number; reviews: number } | null {
  // ratings come from Tier-3 enrichment (local agent), surfaced via company.* later.
  return null;
}

/** Same bands the scorer uses: ≤1 yr short is normal, 2 a stretch, 3+ usually screened out. */
function experienceFit(min: number | null, yoe: number | null): "ok" | "stretch" | "far" | null {
  if (min == null || yoe == null) return null;
  const gap = min - yoe;
  return gap <= 1 ? "ok" : gap <= 2 ? "stretch" : "far";
}
