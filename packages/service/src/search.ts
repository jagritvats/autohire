import { randomUUID } from "node:crypto";
import type { NewPosting, Repository } from "@jobflow/db";
import { SearchQuery, effectiveMarkets, normCompany, scorePosting, type Match, type Posting, type SavedSearch, type SearchQueryInput, type SourceKind } from "@jobflow/core";
import type { SourceAdapter } from "@jobflow/adapters";
import { adhocSearch, isOnboarded, loadProfile, runSavedSearch, type AdhocSearchResult } from "@jobflow/pipeline";
import { corpusEmbedder } from "./embedder.js";
import { demoMode, demoSearchAdapters } from "./demo-corpus.js";
import { rankTenant, toCards, type FeedCard } from "./feed.js";
import { ensureTenant } from "./tenant.js";

/**
 * Job searches (web + CLI). An ad-hoc search asks the search-capable Tier 1-2 sources live
 * and scores the results against YOUR profile with the same honest scorer as the feed;
 * the query is a view over those results (hidden counts are reported, scores untouched).
 */
export interface SearchOutput extends Omit<AdhocSearchResult, "results"> {
  cards: Array<FeedCard & { relevance: number; inFeed: boolean }>;
  /**
   * false before the profile is set up: results are UNSCORED — no score, no fit notes, no
   * hard exclusions (a blank profile has no stack, floor or location to judge against).
   */
  scored: boolean;
  /** with `withPostings`: the scored postings behind `cards` (same order) — transient
   *  unless `inFeed`/ingested, so a local client can keep one the user picks */
  postings?: Posting[];
}

export async function searchJobs(
  repo: Repository,
  tenantId: string,
  query: SearchQueryInput,
  opts: {
    ingest?: boolean;
    limit?: number;
    sources?: SourceKind[];
    sort?: "score" | "relevance" | "pay";
    withPostings?: boolean;
    /** ask these adapters instead of the registry's (tests, offline clients) — the pipeline still keeps only Tier 1–2 */
    adapters?: SourceAdapter[];
  } = {},
): Promise<SearchOutput> {
  await ensureTenant(repo, tenantId);
  const profile = await loadProfile(repo, tenantId);
  const scored = isOnboarded(profile);
  const r = await adhocSearch(query, profile, {
    hardExclude: scored,
    repo,
    embedder: corpusEmbedder(),
    ingest: opts.ingest ?? false,
    limit: opts.limit ?? 30,
    sources: opts.sources,
    sort: opts.sort,
    // demo mode asks the offline fictional boards, never the live ones
    adapters: opts.adapters ?? (demoMode() ? demoSearchAdapters() : undefined),
  });
  // ingested results join the feed: re-rank so they show up there with stored matches
  if (opts.ingest && r.results.length) await rankTenant(repo, tenantId);
  const cards = await toCards(
    repo,
    tenantId,
    r.results.map((x) => ({
      posting: x.posting,
      match: scored ? { score: x.match.score, levelNote: x.match.flags.levelNote, stackNote: x.match.flags.stack.note, redFlags: x.match.flags.redFlags } : null,
    })),
  );
  const { results, ...rest } = r;
  return {
    ...rest,
    scored,
    cards: cards.map((c, i) => ({ ...c, relevance: results[i]!.relevance, inFeed: results[i]!.inFeed })),
    ...(opts.withPostings ? { postings: results.map((x) => x.posting) } : {}),
  };
}

// ── saved searches ──

export interface SavedSearchInput {
  id?: string;
  name: string;
  query: SearchQueryInput;
  asSource?: boolean;
  asView?: boolean;
  cadence?: SavedSearch["cadence"];
  enabled?: boolean;
}

export async function listSearches(repo: Repository, tenantId: string): Promise<SavedSearch[]> {
  return repo.listSavedSearches(tenantId);
}

export async function saveSearch(repo: Repository, tenantId: string, input: SavedSearchInput): Promise<SavedSearch> {
  const existing = input.id ? await repo.getSavedSearch(tenantId, input.id) : null;
  const search: SavedSearch = {
    id: existing?.id ?? randomUUID(),
    tenantId,
    name: input.name.trim().slice(0, 80),
    query: SearchQuery.parse(input.query),
    asSource: input.asSource ?? existing?.asSource ?? true,
    asView: input.asView ?? existing?.asView ?? true,
    cadence: input.cadence ?? existing?.cadence ?? "daily",
    enabled: input.enabled ?? existing?.enabled ?? true,
    lastRunAt: existing?.lastRunAt ?? null,
    lastResult: existing?.lastResult ?? null,
    createdAt: existing?.createdAt ?? new Date(),
  };
  return repo.saveSavedSearch(search);
}

/** find by id, or by name (case-insensitive) — the CLI addresses searches by name. */
export async function findSearch(repo: Repository, tenantId: string, idOrName: string): Promise<SavedSearch | null> {
  const byId = await repo.getSavedSearch(tenantId, idOrName).catch(() => null);
  if (byId) return byId;
  const all = await repo.listSavedSearches(tenantId);
  return all.find((s) => s.name.toLowerCase() === idOrName.toLowerCase()) ?? null;
}

export async function deleteSearch(repo: Repository, tenantId: string, id: string): Promise<void> {
  await repo.deleteSavedSearch(tenantId, id);
}

/** Run a saved search now: ingest what its sources return, then re-rank your feed. */
export async function runSearchNow(repo: Repository, tenantId: string, id: string) {
  const search = await repo.getSavedSearch(tenantId, id);
  if (!search) throw new Error("No such saved search.");
  const profile = await loadProfile(repo, tenantId);
  // demo mode never reaches the live boards: the fictional corpus is already stored
  if (demoMode()) {
    await rankTenant(repo, tenantId);
    return { fetched: 0, upserted: 0, bySource: {}, errors: [] };
  }
  const r = await runSavedSearch(repo, search, { embedder: corpusEmbedder(), markets: effectiveMarkets(profile.prefs), yoe: profile.yoe });
  await rankTenant(repo, tenantId);
  return r;
}

// ── keeping a search result ──

/**
 * Save a transient search result into the corpus, exactly as ingest would (idempotent upsert
 * on (atsType, atsJobId), invariant #5). The company joins the registry as a discovered shell.
 * Used when a person picks a result (opens it, tailors, applies) — searching alone writes nothing.
 */
export async function keepPosting(repo: Repository, p: Posting): Promise<Posting> {
  const company = await repo.upsertCompany({
    name: p.companyName,
    nameNorm: normCompany(p.companyName),
    atsType: p.atsType,
    tags: ["discovered", p.source],
  });
  const {
    id: _id,
    firstSeen: _f,
    lastSeen: _l,
    isActive: _a,
    repostCount: _r,
    canonicalId: _c,
    status: _s,
    invalidReason: _ir,
    invalidatedAt: _ia,
    ...rest
  } = p;
  const np: NewPosting = { ...rest, companyId: company.id, companyName: company.name };
  return repo.upsertPosting(np);
}

/**
 * The web's recent search results, per tenant, held server-side (never trusted from the
 * client) so "open / save / tailor" on a result that isn't in the corpus can keep it.
 * Process memory, bounded; a restart just means searching again.
 */
const recent = new Map<string, Map<string, Posting>>();
const MAX_PER_TENANT = 300;

export function rememberSearchResults(tenantId: string, postings: Posting[]): void {
  const m = recent.get(tenantId) ?? new Map<string, Posting>();
  for (const p of postings) {
    m.delete(p.id);
    m.set(p.id, p);
  }
  while (m.size > MAX_PER_TENANT) m.delete(m.keys().next().value as string);
  recent.set(tenantId, m);
}

/** Keep a remembered result (or return the stored posting if it's already in the corpus). */
export async function keepSearchResult(repo: Repository, tenantId: string, id: string): Promise<Posting | null> {
  const stored = await repo.getPosting(id).catch(() => null);
  if (stored) return stored;
  const p = recent.get(tenantId)?.get(id);
  if (!p) return null;
  const kept = await keepPosting(repo, p);
  recent.get(tenantId)?.delete(id);
  await scoreKept(repo, tenantId, kept);
  return kept;
}

/**
 * Score ONE newly kept posting for this tenant (the same scorer as a full rank; matches
 * upsert per posting), so its Job page shows a real score without re-ranking the corpus.
 * Does nothing before onboarding — there's no candidate to score against.
 */
export async function scoreKept(repo: Repository, tenantId: string, posting: Posting): Promise<void> {
  const profile = await repo.getProfile(tenantId);
  if (!profile || !isOnboarded(profile)) return;
  const s = scorePosting(posting, profile);
  const match: Match = {
    id: randomUUID(),
    tenantId,
    postingId: posting.id,
    score: s.score,
    scoreBreakdown: s.breakdown,
    rulePass: s.rulePass,
    whyFit: s.flags.stack.note,
    gap: null,
    stackNote: s.flags.stack.note,
    levelNote: s.flags.levelNote,
    redFlags: s.flags.hardExclusionReason ? [...s.flags.redFlags, s.flags.hardExclusionReason] : s.flags.redFlags,
    generatedAt: new Date(),
  };
  await repo.saveMatches([match]);
}
