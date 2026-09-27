import { createHash } from "node:crypto";
import type { Company, Posting, RawPosting } from "@jobflow/core";
import {
  embedOrigin,
  isIndiaWorkable,
  normalizePosting,
  parseLocation,
  repostSafeDates,
  scopedJobId,
  type NormalizedPosting,
} from "@jobflow/core";
import { getAdapter, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import type { NewPosting, Repository } from "@jobflow/db";
import { localEmbedder, type Embedder } from "./embedder.js";

export interface IngestStats {
  fetched: number;
  upserted: number;
  staled: number;
  errors: string[];
}

/**
 * Country the big-employer boards are polled for (server-side filter — they list
 * thousands of global roles). Shapes what we poll; ranking still scores location.
 */
export const DEFAULT_POLL_COUNTRY = process.env.JOBFLOW_POLL_COUNTRY ?? "IN";

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
  } = {},
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
  const stored = new Map(existing.map((p) => [p.atsJobId, p]));
  const known = new Set(existing.filter((p) => p.jdText.trim()).map((p) => p.atsJobId));
  const raws = await adapter.fetch({ slug: company.atsSlug, location: opts.country ?? DEFAULT_POLL_COUNTRY, known });
  stats.fetched = raws.length;

  // Adapters return [] on a recoverable error (invariant), which is indistinguishable
  // from an empty board — never mass-stale on it. A board that's truly emptied is
  // retired by the lastSeen TTL sweep in pollAll instead.
  if (raws.length === 0) {
    await repo.touchPolled(company.id);
    return stats;
  }

  // `limit` caps the (embedding-costly) upserts, not the fetch. Global boards list
  // hundreds of roles with a handful in India, so upsert India-workable ones first.
  const toUpsert = opts.limit ? prioritizeIndiaWorkable(raws).slice(0, opts.limit) : raws;
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
  }

  // everything still listed but not re-written is re-confirmed, so it isn't flagged unverified
  const seenIds = raws.map((r) => scopedJobId(r));
  await repo.touchSeen(company.id, seenIds.filter((id) => !written.has(id) && known.has(id)));
  stats.staled = await repo.markStale(company.id, seenIds);
  await repo.touchPolled(company.id);
  return stats;
}

/** Stable sort: India-workable roles first (cheap location-string parse only). */
export function prioritizeIndiaWorkable(raws: RawPosting[]): RawPosting[] {
  const rank = (r: RawPosting) => (isIndiaWorkable(parseLocation(r.locationRaw)) ? 0 : 1);
  return raws
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
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
  opts: { embedder?: Embedder } = {},
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
      tags: ["discovered", adapter.source],
    });
    const before = prior.get(`${normalized.atsType}:${normalized.atsJobId}`);
    const newPosting = await toNewPosting(normalized, company.id, company.name, embedder, before);
    await repo.upsertPosting(newPosting);
    stats.upserted++;
  }
  return stats;
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
