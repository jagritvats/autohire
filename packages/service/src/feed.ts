import type { PurgeOptions, Repository } from "@jobflow/db";
import {
  blankProfile,
  isOnboarded,
  pollAll,
  rebuildMatches,
  recheckPostings,
  type RecheckStats,
} from "@jobflow/pipeline";
import type { Match, Posting, SearchQueryInput, ViewHiddenReason } from "@jobflow/core";
import { applyView, formatSalary, isIndiaWorkable, postingAgeDays, scoreSourceTrust } from "@jobflow/core";
import { ensureTenant } from "./tenant.js";
import { corpusEmbedder } from "./embedder.js";

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
  location: { mode: string; label: string; remoteGeo: string; country: string | null; confidence: number };
  /** parsed years-of-experience the JD asks for (§11.2); nulls when unstated. */
  experience: { min: number | null; max: number | null; fit: "ok" | "stretch" | "far" | null };
  /** true when the role is workable from India (onsite/hybrid IN, or IN-ok/worldwide remote). */
  indiaWorkable: boolean;
  /** the employer is an IT-services / outsourcing firm (company tagged "services"). */
  services: boolean;
  /** source trust 0..1 (§11): source prior × listing signals — real, open, answered. */
  trust: number;
  level: string | null;
  levelNote: string | null;
  stackNote: string | null;
  skills: string[];
  /**
   * Pay: what the posting states, else our estimate (§11.4). `estimate` is never blurred —
   * the UI marks it "~ … est N%" with its basis; stated pay shows its parse confidence.
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
}

export interface FeedData {
  cards: FeedCard[];
  stats: {
    companies: number;
    postings: number;
    ranked: number;
    excluded: number;
    durable: boolean;
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
  /** soft VIEW filter (never a hard exclusion, invariant #4): only India-workable roles. */
  indiaOnly?: boolean;
  /**
   * a saved search (by id) or an ad-hoc query applied as a VIEW: it hides only on
   * confidently-known values, never rescores, and the hidden counts are returned.
   */
  view?: string | SearchQueryInput | null;
  limit?: number;
  /**
   * when the shared corpus is empty, start ONE background sync (deduped across requests)
   * and return immediately instead of polling inside the request. Default true; multi-user
   * deployments leave syncing to the worker and pass false.
   */
  bootstrap?: boolean;
}

let corpusSync: Promise<void> | null = null;

/** Is a background corpus sync running in this process? */
export function corpusSyncing(): boolean {
  return corpusSync != null;
}

/**
 * Start (or join) a background discover → poll of the shared corpus. Deduped: concurrent
 * callers share one run. Request handlers never await it — the UI shows "syncing".
 */
export function startCorpusSync(repo: Repository, after?: () => Promise<void>): Promise<void> {
  corpusSync ??= (async () => {
    try {
      await syncCorpus(repo);
      if (after) await after();
    } catch (e) {
      console.error("[jobflow] corpus sync failed:", e instanceof Error ? e.message : e);
    } finally {
      corpusSync = null;
    }
  })();
  return corpusSync;
}

/** discover seeds + poll boards/feeds — bounded, the same routine the worker runs. */
export async function syncCorpus(repo: Repository, opts: { full?: boolean } = {}): Promise<Awaited<ReturnType<typeof pollAll>>> {
  // the discovery plan (each tenant's preset + custom sources + saved searches) decides
  // WHAT is polled; a first/background sync stays small, `full` is the worker-sized sweep
  return pollAll(
    repo,
    opts.full
      ? { embedder: corpusEmbedder() }
      : { embedder: corpusEmbedder(), limitPerCompany: 50, maxBoards: 25, skipSlowFeeds: true, telegramChannels: [] },
  );
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
  if (!onboarded) {
    const browse = await browsePostings(repo, limit);
    if (browse.length === 0 && opts.bootstrap !== false) void startCorpusSync(repo);
    return shapeBrowse(repo, tenantId, browse);
  }
  let matches = await repo.listMatches(tenantId, limit);
  if (matches.length === 0 && opts.bootstrap !== false) {
    const corpus = await repo.listActivePostings();
    if (corpus.length === 0) void startCorpusSync(repo, async () => void (await rankTenant(repo, tenantId)));
    else {
      await rankTenant(repo, tenantId);
      matches = await repo.listMatches(tenantId, limit);
    }
  }
  if (opts.indiaOnly) matches = matches.filter((m) => isIndiaWorkable(m.posting.location));
  if (opts.view) {
    const query = typeof opts.view === "string" ? (await repo.getSavedSearch(tenantId, opts.view))?.query : opts.view;
    if (query) {
      const v = applyView(matches, query);
      const data = await shape(repo, tenantId, v.shown);
      return { ...data, stats: { ...data.stats, hidden: v.hidden, hiddenTotal: v.hiddenTotal } };
    }
  }
  return shape(repo, tenantId, matches);
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
  await syncCorpus(repo);
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
  /** the profile's years of experience — to mark how far the JD's ask is. */
  yoe: number;
  appliedKeys: Set<string>;
  bookmarked: Set<string>;
  archived: Set<string>;
  /** companies tagged "services" (IT-services / outsourcing employers). */
  servicesCompanyIds: Set<string>;
}

/** Everything `buildCard` needs beyond the posting, loaded once per request. */
async function cardCtx(repo: Repository, tenantId: string, companies?: Awaited<ReturnType<Repository["listCompanies"]>>): Promise<CardCtx> {
  const [appliedKeys, userState, profile, cos] = await Promise.all([
    repo.appliedDedupKeys(tenantId),
    repo.getPostingUserState(tenantId),
    repo.getProfile(tenantId),
    companies ?? repo.listCompanies(),
  ]);
  return {
    yoe: (profile ?? blankProfile(tenantId)).yoe,
    appliedKeys,
    bookmarked: userState.bookmarked,
    archived: userState.archived,
    servicesCompanyIds: new Set(cos.filter((c) => c.tags.includes("services")).map((c) => c.id)),
  };
}

/** Build one card from a posting + its (optional) match. Single source of card shape. */
function buildCard(
  p: Posting,
  m: Pick<Match, "score" | "levelNote" | "stackNote" | "redFlags"> | null,
  ctx: CardCtx,
): FeedCard {
  const ageDays = Math.floor(postingAgeDays(p)); // source publish date, else first seen
  return {
    id: p.id,
    companyId: p.companyId,
    title: p.title,
    company: p.companyName,
    score: m?.score ?? 0,
    archetype: p.roleArchetype,
    source: p.source,
    tier: p.tier,
    ats: p.atsType,
    ageDays,
    atsDirect: p.atsType !== "unknown",
    location: {
      mode: p.location.mode,
      label: [p.location.city, p.location.country].filter(Boolean).join(", "),
      remoteGeo: p.location.remoteGeo,
      country: p.location.country,
      confidence: p.location.confidence,
    },
    experience: { min: p.experience.min, max: p.experience.max, fit: experienceFit(p.experience.min, ctx.yoe) },
    indiaWorkable: isIndiaWorkable(p.location),
    services: ctx.servicesCompanyIds.has(p.companyId),
    trust: Math.round(scoreSourceTrust(p).score * 100) / 100,
    level: p.levelBand,
    levelNote: m?.levelNote ?? null,
    stackNote: m?.stackNote ?? null,
    skills: p.jdSkills.slice(0, 10),
    comp: compLabel(p),
    rating: ratingOf(p),
    redFlags: m?.redFlags ?? [],
    applyUrl: p.applyUrl,
    applied: ctx.appliedKeys.has(p.dedupKey),
    bookmarked: ctx.bookmarked.has(p.id),
    archived: ctx.archived.has(p.id),
    invalidated: p.status === "invalidated",
    invalidReason: p.invalidReason ?? null,
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
      durable: !!process.env.DATABASE_URL || !!process.env.JOBFLOW_DATA_DIR,
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

function compLabel(p: Posting): FeedCard["comp"] {
  const s = p.salary;
  if (s.source !== "none" && (s.min != null || s.max != null)) {
    const f = (n: number) => formatSalary(n, s.currency);
    const label =
      s.min != null && s.max != null ? `${f(s.min)}–${f(s.max)}` : s.max != null ? `up to ${f(s.max)}` : `${f(s.min!)}+`;
    return { label, confidence: s.confidence, source: s.source, estimate: false, confidenceScore: null, basis: null };
  }
  const e = p.salaryEstimate;
  if (!e) return null;
  return {
    label: `${formatSalary(e.min, e.currency)}–${formatSalary(e.max, e.currency)}`,
    confidence: e.confidence,
    source: e.sources.map((x) => x.source).join(" + "),
    estimate: true,
    confidenceScore: e.confidenceScore,
    basis: e.basis,
  };
}

function ratingOf(p: Posting): { overall: number; reviews: number } | null {
  // ratings come from Tier-3 enrichment (local agent), surfaced via company.* later.
  return null;
}

/** Same bands the scorer uses: ≤1 yr short is normal, 2 a stretch, 3+ usually screened out. */
function experienceFit(min: number | null, yoe: number): "ok" | "stretch" | "far" | null {
  if (min == null) return null;
  const gap = min - yoe;
  return gap <= 1 ? "ok" : gap <= 2 ? "stretch" : "far";
}
