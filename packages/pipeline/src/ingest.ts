import type { RawPosting } from "@jobflow/core";
import { normalizePosting, type NormalizedPosting } from "@jobflow/core";
import { getAdapter, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import type { Company, NewPosting, Repository } from "@jobflow/db";
import { localEmbedder, type Embedder } from "./embedder.js";

export interface IngestStats {
  fetched: number;
  upserted: number;
  staled: number;
  errors: string[];
}

/**
 * Poll one registered company via its ATS adapter, normalize, idempotently upsert,
 * and soft-delete postings that disappeared (§3 freshness). The orchestrator calls
 * this for every company due for poll.
 */
export async function ingestCompany(
  repo: Repository,
  company: Company,
  opts: { embedder?: Embedder; limit?: number } = {},
): Promise<IngestStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const stats: IngestStats = { fetched: 0, upserted: 0, staled: 0, errors: [] };

  const adapter = company.atsType !== "unknown" ? getAdapter(company.atsType) : undefined;
  if (!adapter || !company.atsSlug) {
    stats.errors.push(`No adapter/slug for ${company.name} (${company.atsType})`);
    return stats;
  }

  const raws = await adapter.fetch({ slug: company.atsSlug, limit: opts.limit });
  stats.fetched = raws.length;

  const seenIds: string[] = [];
  for (const raw of raws) {
    seenIds.push(raw.atsJobId);
    const normalized = normalizePosting(raw);
    const newPosting = await toNewPosting(normalized, company.id, company.name, embedder);
    await repo.upsertPosting(newPosting);
    stats.upserted++;
  }

  stats.staled = await repo.markStale(company.id, seenIds);
  await repo.touchPolled(company.id);
  return stats;
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

  for (const raw of raws) {
    const normalized = normalizePosting(raw);
    const company = await repo.upsertCompany({
      name: normalized.companyName,
      nameNorm: normalized.companyNameNorm,
      atsType: normalized.atsType,
      atsSlug: normalized.companySlug,
      tags: ["discovered", adapter.source],
    });
    const newPosting = await toNewPosting(normalized, company.id, company.name, embedder);
    await repo.upsertPosting(newPosting);
    stats.upserted++;
  }
  return stats;
}

/** Assemble a NewPosting (repo assigns id/timestamps), computing the JD embedding. */
export async function toNewPosting(
  n: NormalizedPosting,
  companyId: string,
  companyName: string,
  embedder: Embedder,
): Promise<NewPosting> {
  const embedding = await embedder(`${n.title}\n${n.jdSkills.join(" ")}\n${n.jdText.slice(0, 4000)}`);
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
    applyUrl: n.applyUrl,
    jdEmbedding: embedding,
    dedupKey: n.dedupKey,
  };
}
