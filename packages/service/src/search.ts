import { randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { SearchQuery, effectiveMarkets, type SavedSearch, type SearchQueryInput, type SourceKind } from "@jobflow/core";
import { adhocSearch, loadProfile, runSavedSearch, type AdhocSearchResult } from "@jobflow/pipeline";
import { corpusEmbedder } from "./embedder.js";
import { rankTenant, toCards, type FeedCard } from "./feed.js";
import { ensureTenant } from "./tenant.js";

/**
 * Job searches (web + CLI). An ad-hoc search asks the search-capable Tier 1-2 sources live
 * and scores the results against YOUR profile with the same honest scorer as the feed;
 * the query is a view over those results (hidden counts are reported, scores untouched).
 */
export interface SearchOutput extends Omit<AdhocSearchResult, "results"> {
  cards: Array<FeedCard & { relevance: number; inFeed: boolean }>;
}

export async function searchJobs(
  repo: Repository,
  tenantId: string,
  query: SearchQueryInput,
  opts: { ingest?: boolean; limit?: number; sources?: SourceKind[]; sort?: "score" | "relevance" } = {},
): Promise<SearchOutput> {
  await ensureTenant(repo, tenantId);
  const profile = await loadProfile(repo, tenantId);
  const r = await adhocSearch(query, profile, {
    repo,
    embedder: corpusEmbedder(),
    ingest: opts.ingest ?? false,
    limit: opts.limit ?? 30,
    sources: opts.sources,
    sort: opts.sort,
  });
  // ingested results join the feed: re-rank so they show up there with stored matches
  if (opts.ingest && r.results.length) await rankTenant(repo, tenantId);
  const cards = await toCards(
    repo,
    tenantId,
    r.results.map((x) => ({
      posting: x.posting,
      match: { score: x.match.score, levelNote: x.match.flags.levelNote, stackNote: x.match.flags.stack.note, redFlags: x.match.flags.redFlags },
    })),
  );
  const { results, ...rest } = r;
  return { ...rest, cards: cards.map((c, i) => ({ ...c, relevance: results[i]!.relevance, inFeed: results[i]!.inFeed })) };
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
  const r = await runSavedSearch(repo, search, { embedder: corpusEmbedder(), markets: effectiveMarkets(profile.prefs), yoe: profile.yoe });
  await rankTenant(repo, tenantId);
  return r;
}
