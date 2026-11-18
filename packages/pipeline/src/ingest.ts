import { createHash } from "node:crypto";
import type { Company, Posting, RawPosting } from "@jobflow/core";
import {
  embedOrigin,
  isWorkableIn,
  normalizePosting,
  parseLocation,
  repostSafeDates,
  scopedJobId,
  type NormalizedPosting,
} from "@jobflow/core";
import { getAdapter, isPartialFetch, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import type { NewPosting, Repository } from "@jobflow/db";
import { localEmbedder, type Embedder } from "./embedder.js";

export interface IngestStats {
  fetched: number;
  upserted: number;
  staled: number;
  errors: string[];
  /** upserted postings we didn't hold before (sync progress: "new") */
  created?: number;
}

/**
 * Country the big-employer boards are polled for (server-side filter — they list
 * thousands of global roles). Shapes what we poll; ranking still scores location.
 * Read at CALL time: apps load `.env` after this module is imported, so a module-level
 * constant missed JOBFLOW_POLL_COUNTRY. A comma list names several; this is the first.
 */
export function defaultPollCountry(): string {
  return csvCountries(process.env.JOBFLOW_POLL_COUNTRY)[0] ?? "IN";
}

/**
 * @deprecated read at module load (before `.env` is applied) — use `defaultPollCountry()`
 * or the discovery plan's `pollCountries`. Kept for existing importers.
 */
export const DEFAULT_POLL_COUNTRY = process.env.JOBFLOW_POLL_COUNTRY ?? "IN";

/** "IN, us" → ["IN", "US"] (ISO-2 only, deduped). */
export function csvCountries(v: string | undefined): string[] {
  return [...new Set((v ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))];
}

/**
 * Boards whose adapters filter by `location` server-side — the only ones a multi-market
 * poll fetches once per country. Every other board returns the same full list whatever
 * the country, so it's fetched once.
 */
export const COUNTRY_FILTERED_ATS: ReadonlySet<string> = new Set([
  "workday",
  "eightfold",
  "amazon",
  "oracle",
  "smartrecruiters",
  "rippling",
  "jobvite",
  "atlassian",
  "jibe",
  "talentbrew",
]);

/** company tag recording the market set a country-filtered board was last polled for. */
export const MARKETS_TAG_PREFIX = "poll-markets:";

/**
 * Poll one registered company via its ATS adapter, normalize, idempotently upsert,
 * and soft-delete postings that disappeared (§3 freshness). The orchestrator calls
 * this for every company due for poll.
 */
export async function ingestCompany(
  repo: Repository,
  company: Company,
  opts: {
    embedder?: Embedder;
    limit?: number;
    country?: string;
    /**
     * board adapter to use instead of the cloud registry's — the local agent passes its
     * session-bound Tier-3 board adapters (Darwinbox) so they share this diff/stale logic.
     */
    adapter?: SourceAdapter;
    /**
     * poll for SEVERAL countries (multi-market tenants): country-filtered boards are fetched
     * once per country and merged by id. Wins over `country` when it has 2+ entries.
     */
    countries?: string[];
    /**
     * asked right before the stale diff: false skips it (a cancelled sync never soft-deletes
     * — the next full poll diffs instead; invariant #5). Default: allowed.
     */
    mayStale?: () => boolean;
  } = {},
): Promise<IngestStats> {
  const countries = [...new Set((opts.countries ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (countries.length > 1 && COUNTRY_FILTERED_ATS.has(opts.adapter?.source ?? company.atsType)) {
    return ingestCompanyMulti(repo, company, { ...opts, countries });
  }
  const country = opts.country ?? (countries.length === 1 ? countries[0] : undefined);
  return ingestCompanySingle(repo, company, { ...opts, country });
}

async function ingestCompanySingle(
  repo: Repository,
  company: Company,
  opts: { embedder?: Embedder; limit?: number; country?: string; adapter?: SourceAdapter; mayStale?: () => boolean },
): Promise<IngestStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const stats: IngestStats = { fetched: 0, upserted: 0, staled: 0, errors: [] };

  const adapter = opts.adapter ?? (company.atsType !== "unknown" ? getAdapter(company.atsType) : undefined);
  if (!adapter || !company.atsSlug) {
    stats.errors.push(`No adapter/slug for ${company.name} (${company.atsType})`);
    return stats;
  }

  // Always fetch the WHOLE board: staleness is a diff against everything that's live, so
  // truncating the fetch would soft-delete every live posting past the limit (§3).
  // `country` lets big-employer boards (Workday/Eightfold/SmartRecruiters/Amazon) filter
  // server-side — it shapes what we poll, it is not a match filter (invariant #4).
  // `known` lets boards with per-posting detail calls skip re-fetching stored JDs.
  const existing = await repo.listPostingsByCompany(company.id);
  const known = new Set(existing.filter((p) => p.jdText.trim()).map((p) => p.atsJobId));
  const country = opts.country ?? defaultPollCountry();
  const raws = await adapter.fetch({ slug: company.atsSlug, location: country, known });
  stats.fetched = raws.length;

  // Adapters return [] on a recoverable error (invariant), which is indistinguishable
  // from an empty board — never mass-stale on it. A board that's truly emptied is
  // retired by the lastSeen TTL sweep in pollAll instead.
  if (raws.length === 0) {
    await repo.touchPolled(company.id);
    return stats;
  }

  // a company last polled for several markets: its stored set no longer matches this one
  const marketsTag = company.tags.find((t) => t.startsWith(MARKETS_TAG_PREFIX));
  const marketsChanged = !!marketsTag && marketsTag !== marketsTagFor([country]);
  await upsertBoard(repo, company, adapter, raws, existing, known, embedder, stats, {
    limit: opts.limit,
    markets: [country],
    // a partial list (an unfiltered fallback, a list cut at its cap) or a changed market set
    // can't be diffed: what's missing may still be live (invariant #5) — the TTL sweep retires
    stale: !isPartialFetch(raws) && !marketsChanged,
    mayStale: opts.mayStale,
  });
  if (marketsChanged) await repo.updateCompany(company.id, { tags: company.tags.filter((t) => t !== marketsTag) });
  await repo.touchPolled(company.id);
  return stats;
}

/**
 * Multi-market poll of a country-filtered board: one fetch per country, merged by id.
 * markStale runs only when EVERY per-country fetch returned something (an empty one can't
 * be told from an error), none was partial, and the market set is the one polled last
 * time — otherwise a role listed only in a country that failed (or wasn't polled before)
 * would be soft-deleted. The lastSeen TTL sweeps retire what's truly gone.
 */
async function ingestCompanyMulti(
  repo: Repository,
  company: Company,
  opts: { embedder?: Embedder; limit?: number; adapter?: SourceAdapter; countries: string[]; mayStale?: () => boolean },
): Promise<IngestStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const stats: IngestStats = { fetched: 0, upserted: 0, staled: 0, errors: [] };
  const adapter = opts.adapter ?? (company.atsType !== "unknown" ? getAdapter(company.atsType) : undefined);
  if (!adapter || !company.atsSlug) {
    stats.errors.push(`No adapter/slug for ${company.name} (${company.atsType})`);
    return stats;
  }
  const existing = await repo.listPostingsByCompany(company.id);
  const known = new Set(existing.filter((p) => p.jdText.trim()).map((p) => p.atsJobId));

  const merged = new Map<string, RawPosting>();
  let anyEmpty = false;
  let anyPartial = false;
  for (const country of opts.countries) {
    let batch: RawPosting[] = [];
    try {
      batch = await adapter.fetch({ slug: company.atsSlug, location: country, known });
    } catch (e) {
      stats.errors.push(`${company.name} [${country}]: ${(e as Error).message}`);
    }
    if (!batch.length) anyEmpty = true;
    if (isPartialFetch(batch)) anyPartial = true;
    for (const raw of batch) {
      const id = scopedJobId(raw);
      const prev = merged.get(id);
      // the same role listed for two countries: keep the richer copy (one with a JD)
      if (!prev || (!prev.jdText.trim() && raw.jdText.trim())) merged.set(id, raw);
    }
  }
  const raws = [...merged.values()];
  stats.fetched = raws.length;
  const tag = marketsTagFor(opts.countries);
  const previousTag = company.tags.find((t) => t.startsWith(MARKETS_TAG_PREFIX));
  const marketsChanged = previousTag !== tag;

  if (raws.length) {
    await upsertBoard(repo, company, adapter, raws, existing, known, embedder, stats, {
      limit: opts.limit,
      markets: opts.countries,
      stale: !anyEmpty && !anyPartial && !marketsChanged,
      mayStale: opts.mayStale,
    });
  }
  if (marketsChanged) {
    await repo.updateCompany(company.id, { tags: [...company.tags.filter((t) => !t.startsWith(MARKETS_TAG_PREFIX)), tag] });
  }
  await repo.touchPolled(company.id);
  return stats;
}

/** canonical market-set tag, e.g. "poll-markets:DE+GB+IN". */
export function marketsTagFor(countries: string[]): string {
  return `${MARKETS_TAG_PREFIX}${[...new Set(countries.map((c) => c.toUpperCase()))].sort().join("+")}`;
}

/** normalize + upsert one board's fetch, re-confirm the rest, and (when allowed) diff-stale. */
async function upsertBoard(
  repo: Repository,
  company: Company,
  adapter: SourceAdapter,
  raws: RawPosting[],
  existing: Posting[],
  known: Set<string>,
  embedder: Embedder,
  stats: IngestStats,
  opts: { limit?: number; markets: string[]; stale: boolean; mayStale?: () => boolean },
): Promise<void> {
  const stored = new Map(existing.map((p) => [p.atsJobId, p]));
  // `limit` caps the (embedding-costly) upserts, not the fetch. Global boards list
  // hundreds of roles with a handful in the polled markets, so upsert workable ones first —
  // and within each, roles we don't hold yet: the ones we do are re-confirmed below anyway,
  // and re-upserting the same first N every poll meant a board's later roles never landed.
  const toUpsert = opts.limit ? prioritizeWorkable(raws, opts.markets, known).slice(0, opts.limit) : raws;
  // repost-proof publish dates from the WHOLE board (id order needs every neighbour)
  const dates = repostSafeDates(adapter.source, raws.map((raw) => ({ id: scopedJobId(raw), raw })), stored);
  const written = new Set<string>();
  for (const raw of toUpsert) {
    const id = scopedJobId(raw);
    // a lite listing (no JD) for a posting we already hold would overwrite its JD — skip
    if (!raw.jdText.trim() && known.has(id)) continue;
    written.add(id);
    const normalized = normalizePosting(dates.has(id) ? { ...raw, postedAt: dates.get(id)! } : raw);
    const newPosting = await toNewPosting(normalized, company.id, company.name, embedder, stored.get(id));
    await repo.upsertPosting(newPosting);
    stats.upserted++;
    if (!stored.has(id)) stats.created = (stats.created ?? 0) + 1;
  }

  // everything still listed but not re-written is re-confirmed, so it isn't flagged unverified
  const seenIds = raws.map((r) => scopedJobId(r));
  await repo.touchSeen(company.id, seenIds.filter((id) => !written.has(id) && known.has(id)));
  if (opts.stale && (opts.mayStale?.() ?? true)) stats.staled = await repo.markStale(company.id, seenIds);
}

/**
 * Stable sort: roles workable in `markets` first (cheap location-string parse only); within
 * each group, roles not in `held` (scoped ids already stored with a JD) first.
 */
export function prioritizeWorkable(raws: RawPosting[], markets: readonly string[], held: ReadonlySet<string> = new Set()): RawPosting[] {
  const rank = (r: RawPosting) => (isWorkableIn(parseLocation(r.locationRaw), markets) ? 0 : 2) + (held.has(scopedJobId(r)) ? 1 : 0);
  return raws
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

/** India wrapper (kept for callers): `prioritizeWorkable(raws, ["IN"])`. */
export function prioritizeIndiaWorkable(raws: RawPosting[]): RawPosting[] {
  return prioritizeWorkable(raws, ["IN"]);
}

/**
 * Ingest from a discovery adapter (aggregator / HN) where postings carry only a
 * company NAME. Resolves/creates the company shell; the ATS Detector later upgrades
 * it to a real board so we re-poll the rich source (§ discovery routing).
 */
export async function ingestFromAdapter(
  repo: Repository,
  adapterOrSource: SourceAdapter | string,
  target: FetchTarget,
  opts: {
    embedder?: Embedder;
    /** sees the fetched raw postings (e.g. to harvest ATS links from a custom feed). */
    onRaws?: (raws: RawPosting[]) => void;
  } = {},
): Promise<IngestStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const adapter =
    typeof adapterOrSource === "string" ? getAdapter(adapterOrSource as never) : adapterOrSource;
  const stats: IngestStats = { fetched: 0, upserted: 0, staled: 0, errors: [] };
  if (!adapter) {
    stats.errors.push(`Unknown adapter: ${String(adapterOrSource)}`);
    return stats;
  }

  let raws: RawPosting[] = [];
  try {
    raws = await adapter.fetch(target);
  } catch (e) {
    stats.errors.push(`${adapter.source}: ${(e as Error).message}`);
    return stats;
  }
  stats.fetched = raws.length;
  opts.onRaws?.(raws);
  const counted = await ingestRawsCounted(repo, adapter.source, raws, embedder);
  stats.upserted = counted.upserted;
  stats.created = counted.created;
  return stats;
}

/**
 * Upsert already-fetched discovery postings (company shells by name, idempotent on
 * (atsType, atsJobId) — invariant #5). Returns the number upserted. Shared by
 * `ingestFromAdapter` and an ad-hoc search the user chose to keep.
 */
export async function ingestRaws(repo: Repository, source: string, raws: RawPosting[], embedder: Embedder = localEmbedder): Promise<number> {
  return (await ingestRawsCounted(repo, source, raws, embedder)).upserted;
}

/** `ingestRaws`, also counting the postings we didn't hold before. */
async function ingestRawsCounted(repo: Repository, source: string, raws: RawPosting[], embedder: Embedder): Promise<{ upserted: number; created: number }> {
  let upserted = 0;
  let created = 0;
  // what we already hold for these ids — an unchanged posting keeps its stored embedding
  const normalizedAll = raws.map((raw) => normalizePosting(raw));
  const prior = new Map<string, Posting>();
  for (const atsType of new Set(normalizedAll.map((n) => n.atsType))) {
    const ids = normalizedAll.filter((n) => n.atsType === atsType).map((n) => n.atsJobId);
    for (const p of await repo.findPostingsByAtsIds(atsType, ids)) prior.set(`${p.atsType}:${p.atsJobId}`, p);
  }

  for (const normalized of normalizedAll) {
    const company = await repo.upsertCompany({
      name: normalized.companyName,
      nameNorm: normalized.companyNameNorm,
      atsType: normalized.atsType,
      atsSlug: normalized.companySlug,
      tags: ["discovered", source],
    });
    const before = prior.get(`${normalized.atsType}:${normalized.atsJobId}`);
    const newPosting = await toNewPosting(normalized, company.id, company.name, embedder, before);
    await repo.upsertPosting(newPosting);
    upserted++;
    if (!before) created++;
  }
  return { upserted, created };
}

export interface RecheckStats {
  requested: number;
  companies: number;
  fetched: number;
  upserted: number;
  staled: number;
  /** requested postings whose company was successfully re-polled (verified fresh/gone). */
  verified: number;
  /** companies that couldn't be re-polled (no resolved ATS board). */
  skipped: string[];
}

/**
 * Mass recheck: re-verify a set of postings by re-polling their ATS boards through
 * the SAME machinery the poller uses (`ingestCompany`) — refetch → idempotent upsert
 * (bumps lastSeen) → markStale for any that disappeared (§3). No adapter logic is
 * duplicated. Postings whose company has no resolved board can't be verified and are
 * reported in `skipped`. One re-poll per distinct company covers all its requested ids.
 */
export async function recheckPostings(
  repo: Repository,
  postingIds: string[],
  opts: { embedder?: Embedder; limit?: number } = {},
): Promise<RecheckStats> {
  const stats: RecheckStats = { requested: postingIds.length, companies: 0, fetched: 0, upserted: 0, staled: 0, verified: 0, skipped: [] };

  // resolve the distinct companies behind the requested postings
  const companyIds = new Map<string, string[]>(); // companyId → its requested postingIds
  for (const id of postingIds) {
    const p = await repo.getPosting(id);
    if (!p) continue;
    const list = companyIds.get(p.companyId) ?? [];
    list.push(id);
    companyIds.set(p.companyId, list);
  }

  for (const [companyId, ids] of companyIds) {
    const company = await repo.getCompany(companyId);
    // no cloud adapter (Darwinbox is polled by the local agent) → can't be verified here
    if (!company || company.atsType === "unknown" || !company.atsSlug || !getAdapter(company.atsType)) {
      stats.skipped.push(company?.name ?? companyId);
      continue;
    }
    const r = await ingestCompany(repo, company, { embedder: opts.embedder, limit: opts.limit });
    stats.companies++;
    stats.fetched += r.fetched;
    stats.upserted += r.upserted;
    stats.staled += r.staled;
    stats.verified += ids.length;
  }
  return stats;
}

/**
 * Assemble a NewPosting (repo assigns id/timestamps) with its JD embedding. Every poll
 * re-upserts every posting, so embedding is the recurring cost once a paid model is on:
 * when `prior` (the stored row) was embedded from the same text by the same model, its
 * vector is reused instead of paying again.
 */
export async function toNewPosting(
  n: NormalizedPosting,
  companyId: string,
  companyName: string,
  embedder: Embedder,
  prior?: Pick<Posting, "embedKey" | "jdEmbedding">,
): Promise<NewPosting> {
  const text = `${n.title}\n${n.jdSkills.join(" ")}\n${n.jdText.slice(0, 4000)}`;
  const textHash = createHash("sha1").update(text).digest("hex").slice(0, 20);
  const wanted = `${embedder.id ?? "custom"}:${textHash}`;
  let embedding: number[];
  let embedKey: string;
  if (prior?.embedKey === wanted && prior.jdEmbedding?.length) {
    embedding = prior.jdEmbedding;
    embedKey = wanted;
  } else {
    embedding = await embedder(text);
    // a provider that silently fell back to the local embedder produced a LOCAL vector —
    // key it as such, so it's replaced once the real model answers again
    embedKey = `${embedOrigin(embedding) ?? embedder.id ?? "custom"}:${textHash}`;
  }
  return {
    companyId,
    companyName,
    atsType: n.atsType,
    atsJobId: n.atsJobId,
    source: n.source,
    tier: n.tier,
    title: n.title,
    titleNorm: n.titleNorm,
    roleArchetype: n.roleArchetype,
    levelBand: n.levelBand,
    jdText: n.jdText,
    jdSkills: n.jdSkills,
    requirements: n.requirements,
    location: n.location,
    locationRaw: n.locationRaw,
    salary: n.salary,
    salaryRaw: n.salaryRaw,
    experience: n.experience,
    applyUrl: n.applyUrl,
    postedAt: n.postedAt,
    postedByAgency: n.postedByAgency,
    jdEmbedding: embedding,
    embedKey,
    dedupKey: n.dedupKey,
  };
}
