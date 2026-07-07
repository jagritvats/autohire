import "server-only";
import type { PurgeOptions, Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
  recheckPostings,
  type RecheckStats,
} from "@jobflow/pipeline";
import { getAdapter } from "@jobflow/adapters";
import type { Match, Posting } from "@jobflow/core";
import { isIndiaWorkable } from "@jobflow/core";
import { getRepo, ensureTenant } from "./repo.js";

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
  experience: { min: number | null; max: number | null };
  /** true when the role is workable from India (onsite/hybrid IN, or IN-ok/worldwide remote). */
  indiaWorkable: boolean;
  level: string | null;
  levelNote: string | null;
  stackNote: string | null;
  skills: string[];
  comp: { label: string; confidence: string; source: string } | null;
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
  stats: { companies: number; postings: number; ranked: number; excluded: number; durable: boolean; generatedAt: string };
}

/** The secondary views (per-user / lifecycle collections), rendered as feed cards. */
export type PostingView = "bookmarks" | "archived" | "invalidated";

/**
 * Read the feed from the repo. Bootstraps + ingests once if the store is empty.
 * `indiaOnly` is a soft VIEW filter (not a hard exclusion, invariant #4): it shows
 * only India-workable roles for a user who wants them.
 */
export async function getFeed(opts: { indiaOnly?: boolean } = {}): Promise<FeedData> {
  const repo = await getRepo();
  await ensureTenant(repo);
  let matches = await repo.listMatches(DEFAULT_TENANT, 80);
  if (matches.length === 0) {
    await ingestAndRank(repo);
    matches = await repo.listMatches(DEFAULT_TENANT, 80);
  }
  if (opts.indiaOnly) matches = matches.filter((m) => isIndiaWorkable(m.posting.location));
  return shape(repo, matches);
}

/** Force a fresh poll of the live Tier 1-2 sources + re-rank, then return the feed. */
export async function refreshFeed(): Promise<FeedData> {
  const repo = await getRepo();
  await ensureTenant(repo);
  await ingestAndRank(repo);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return shape(repo, matches);
}

/** Re-rank only (after a settings change) — no re-poll. */
export async function rerankOnly(): Promise<FeedData> {
  const repo = await getRepo();
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  await rebuildMatches(repo, profile);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return shape(repo, matches);
}

async function ingestAndRank(repo: Repository): Promise<void> {
  await discoverCompanies(repo, SEED_COMPANIES);
  const companies = await repo.listCompanies({ status: "active" });
  for (const c of companies) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    await ingestCompany(repo, c, { limit: 50 });
  }
  await ingestFromAdapter(repo, getAdapter("hn_whoishiring")!, { query: "backend", limit: 40 });
  await ingestFromAdapter(repo, getAdapter("remotive")!, { query: "backend", limit: 40 });
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  await rebuildMatches(repo, profile);
}

/** Card context — the per-user overlays needed to render correct action state. */
interface CardCtx {
  appliedKeys: Set<string>;
  bookmarked: Set<string>;
  archived: Set<string>;
}

/** Build one card from a posting + its (optional) match. Single source of card shape. */
function buildCard(
  p: Posting,
  m: Pick<Match, "score" | "levelNote" | "stackNote" | "redFlags"> | null,
  ctx: CardCtx,
): FeedCard {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(p.firstSeen as string).getTime()) / 86_400_000));
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
    experience: { min: p.experience.min, max: p.experience.max },
    indiaWorkable: isIndiaWorkable(p.location),
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

async function shape(repo: Repository, matches: Awaited<ReturnType<Repository["listMatches"]>>): Promise<FeedData> {
  const [appliedKeys, userState] = await Promise.all([
    repo.appliedDedupKeys(DEFAULT_TENANT),
    repo.getPostingUserState(DEFAULT_TENANT),
  ]);
  const ctx: CardCtx = { appliedKeys, bookmarked: userState.bookmarked, archived: userState.archived };
  const cards: FeedCard[] = matches.map((m) => buildCard(m.posting, m, ctx));
  const allActive = await repo.listActivePostings();
  return {
    cards,
    stats: {
      companies: (await repo.listCompanies()).length,
      postings: allActive.length,
      ranked: cards.length,
      excluded: 0,
      durable: !!process.env.DATABASE_URL,
      generatedAt: new Date().toISOString(),
    },
  };
}

/** A secondary collection (bookmarks / archived / invalidated), shaped as feed cards. */
export async function getPostingsView(view: PostingView): Promise<{ cards: FeedCard[]; view: PostingView }> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const [appliedKeys, userState] = await Promise.all([
    repo.appliedDedupKeys(DEFAULT_TENANT),
    repo.getPostingUserState(DEFAULT_TENANT),
  ]);
  const ctx: CardCtx = { appliedKeys, bookmarked: userState.bookmarked, archived: userState.archived };

  const postings =
    view === "bookmarks"
      ? await repo.listBookmarkedPostings(DEFAULT_TENANT)
      : view === "archived"
        ? await repo.listArchivedPostings(DEFAULT_TENANT)
        : await repo.listInvalidatedPostings();

  const matches = await repo.listMatchesForPostings(DEFAULT_TENANT, postings.map((p) => p.id));
  const byPosting = new Map(matches.map((m) => [m.postingId, m]));
  const cards = postings
    .map((p) => buildCard(p, byPosting.get(p.id) ?? null, ctx))
    .sort((a, b) => b.score - a.score);
  return { cards, view };
}

/** Mass recheck a set of postings (re-poll their boards) + re-rank, then return the feed. */
export async function recheckFeed(postingIds: string[]): Promise<FeedData & { recheck: RecheckStats }> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const recheck = await recheckPostings(repo, postingIds, { limit: 50 });
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  await rebuildMatches(repo, profile);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return { ...(await shape(repo, matches)), recheck };
}

/** Bulk soft-delete / hard-purge postings older than a threshold; return the fresh feed. */
export async function purgeOldFeed(opts: PurgeOptions): Promise<FeedData & { purged: number }> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const purged = await repo.purgeOldPostings(opts);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return { ...(await shape(repo, matches)), purged };
}

function compLabel(p: Posting) {
  const s = p.salary;
  if (s.min == null && s.max == null) return null;
  const f = (n: number) =>
    s.currency === "INR" ? `₹${(n / 100000).toFixed(0)}L` : s.currency === "USD" ? `$${Math.round(n / 1000)}k` : `${Math.round(n / 1000)}k`;
  const label = s.min != null && s.max != null ? `${f(s.min)}–${f(s.max)}` : `${f((s.min ?? s.max)!)}+`;
  return { label, confidence: s.confidence, source: s.source };
}

function ratingOf(p: Posting): { overall: number; reviews: number } | null {
  // ratings come from Tier-3 enrichment (local agent), surfaced via company.* later.
  return null;
}
