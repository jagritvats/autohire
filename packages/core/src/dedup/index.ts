import type { Posting } from "../schema/entities.js";
import type { SourceKind } from "../schema/enums.js";
import { cosine } from "../util/vector.js";

/**
 * Deduper (§ Deduper). Same role surfaces via Greenhouse *and* an aggregator.
 * Two stages:
 *   1. cheap canonical key  (already computed in normalize → posting.dedupKey)
 *   2. embedding cosine for near-collisions the key misses (different title
 *      phrasings, slightly different locations).
 * Winner = the ATS-direct source (richest data, ghost-free). Aggregator dupes
 * point at it via canonicalId.
 */

// richest → poorest, for picking the canonical winner in a dup cluster
const SOURCE_RICHNESS: SourceKind[] = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
  "linkedin",
  "naukri",
  "remotive",
  "arbeitnow",
  "jobicy",
  "remoteok",
  "adzuna",
  "linkedin_guest",
  "hn_whoishiring",
];

function richness(s: SourceKind): number {
  const i = SOURCE_RICHNESS.indexOf(s);
  return i === -1 ? 999 : i;
}

export interface DedupResult {
  /** the chosen canonical posting id for each cluster member */
  canonicalByPostingId: Map<string, string>;
  /** distinct canonical posting ids, in input order */
  canonicalIds: string[];
}

export interface DedupOptions {
  /** cosine threshold above which two same-company postings merge (default 0.92) */
  embeddingThreshold?: number;
}

/**
 * Cluster a set of postings and assign each a canonical id. Pure function over the
 * provided set — the repository applies the resulting canonicalId column.
 */
export function dedup(postings: Posting[], opts: DedupOptions = {}): DedupResult {
  const threshold = opts.embeddingThreshold ?? 0.92;
  const canonicalByPostingId = new Map<string, string>();

  // stage 1: bucket by exact canonical key
  const byKey = new Map<string, Posting[]>();
  for (const p of postings) {
    const bucket = byKey.get(p.dedupKey);
    if (bucket) bucket.push(p);
    else byKey.set(p.dedupKey, [p]);
  }

  // each key-bucket is one cluster; stage 2 additionally merges cross-key
  // near-collisions within the SAME normalized company (cheap, bounded).
  const clusters: Posting[][] = [...byKey.values()];

  // stage 2: merge clusters of the same company whose lead postings are
  // embedding-similar above threshold (handles "Sr Backend Eng" vs "Backend Engineer II")
  const merged = mergeSimilarClusters(clusters, threshold);

  const canonicalIds: string[] = [];
  for (const cluster of merged) {
    const winner = [...cluster].sort((a, b) => richness(a.source) - richness(b.source))[0]!;
    canonicalIds.push(winner.id);
    for (const p of cluster) canonicalByPostingId.set(p.id, winner.id);
  }

  return { canonicalByPostingId, canonicalIds };
}

function companyOf(p: Posting): string {
  return p.dedupKey.split("|")[0] ?? "";
}

function mergeSimilarClusters(clusters: Posting[][], threshold: number): Posting[][] {
  const result: Posting[][] = [];
  for (const cluster of clusters) {
    const lead = cluster[0]!;
    let mergedInto: Posting[] | null = null;
    for (const existing of result) {
      const exLead = existing[0]!;
      if (companyOf(exLead) !== companyOf(lead)) continue;
      if (!lead.jdEmbedding || !exLead.jdEmbedding) continue;
      if (cosine(lead.jdEmbedding, exLead.jdEmbedding) >= threshold) {
        mergedInto = existing;
        break;
      }
    }
    if (mergedInto) mergedInto.push(...cluster);
    else result.push([...cluster]);
  }
  return result;
}

/**
 * Don't-double-apply guard (§7): given the set of posting ids you've already
 * applied to (or been rejected from), and the canonical mapping, return true if a
 * candidate posting resolves to a company+role you've already actioned.
 */
export function alreadyApplied(
  candidate: Posting,
  appliedPostingKeys: Set<string>,
): boolean {
  // key on company+title so a re-post under a new ats_job_id still trips the guard
  const key = candidate.dedupKey;
  return appliedPostingKeys.has(key);
}
