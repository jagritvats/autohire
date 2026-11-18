import type { Posting } from "../schema/entities.js";
import type { SourceKind } from "../schema/enums.js";
import { cosine } from "../util/vector.js";
import { EUROPE_CODES, cityKey, locationCountryCodes, postingDedupKey } from "../normalize/index.js";
import { dedupTitleKey, normCompany } from "../normalize/titles.js";

/**
 * Deduper (§ Deduper). Same role surfaces via Greenhouse *and* an aggregator.
 * Two stages:
 *   1. cheap canonical key  (already computed in normalize → posting.dedupKey)
 *   2. embedding cosine for near-collisions the key misses (different title
 *      phrasings, slightly different locations).
 * Winner = the ATS-direct source (richest data, ghost-free). Aggregator dupes
 * point at it via canonicalId.
 */

// richest → poorest, for picking the canonical winner in a dup cluster. Every source with a
// SOURCE_TRUST prior is ranked (test/dedup-richness); an unranked one loses every tie.
export const SOURCE_RICHNESS: readonly SourceKind[] = [
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "teamtailor",
  "bamboohr",
  "breezy",
  "smartrecruiters",
  "workday",
  "eightfold",
  "amazon",
  "oracle",
  "rippling",
  "jobvite",
  "atlassian",
  "keka",
  "zoho",
  "freshteam",
  "kula",
  "jibe",
  "talentbrew",
  "darwinbox",
  "hirist",
  "cutshort",
  "instahyre",
  "wellfound",
  "yc",
  "peerlist",
  "timesjobs",
  "reddit",
  "himalayas",
  "linkedin",
  "naukri",
  "remotive",
  "arbeitnow",
  "jobicy",
  "remoteok",
  "adzuna",
  "careerjet",
  "jsearch",
  "linkedin_guest",
  "hn_whoishiring",
  // user-configured feeds: unknown provenance, often a re-post of a board's listing
  "rss",
  "json_feed",
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
  /** JD-embedding cosine that lets two near-identical titles merge across sources (default 0.92) */
  embeddingThreshold?: number;
}

/**
 * Cluster a set of postings and assign each a canonical id. Pure function over the
 * provided set — the repository applies the resulting canonicalId column.
 *
 * Measured on live corpora (audit 2026-11) the old rules hid 43–45% of all postings: the
 * stage-1 key used the coarse `titleNorm` (every "… Software Engineer …" at a company+city,
 * even a "Group Product Manager, Developer Infrastructure", shared one key), and stage 2
 * merged any same-company pair whose JD embeddings were ≥0.92 alike — with the offline
 * embedder that is boilerplate, so a company's sales, support and engineering roles became
 * one card. A duplicate is the SAME role surfacing twice, so:
 *   stage 1  exact key: company + `dedupTitleKey` (team/specialty/level kept) + location;
 *   stage 2  only ACROSS sources (two ids on one board are two reqs), same company, same
 *            level, a compatible location, and near-identical titles — the embedding can
 *            confirm a close title, never stand in for one.
 */
export function dedup(postings: Posting[], opts: DedupOptions = {}): DedupResult {
  const threshold = opts.embeddingThreshold ?? 0.92;
  const canonicalByPostingId = new Map<string, string>();

  // stage 1: bucket by exact key — recomputed, since stored keys may predate a key change
  const byKey = new Map<string, Posting[]>();
  for (const p of postings) {
    const k = postingDedupKey(p);
    const bucket = byKey.get(k);
    if (bucket) bucket.push(p);
    else byKey.set(k, [p]);
  }

  // stage 2: cross-source near-collisions, compared only within one company
  const byCompany = new Map<string, Posting[][]>();
  for (const cluster of byKey.values()) {
    const c = normCompany(cluster[0]!.companyName);
    const list = byCompany.get(c);
    if (list) list.push(cluster);
    else byCompany.set(c, [cluster]);
  }
  const merged: Posting[][] = [];
  for (const clusters of byCompany.values()) merged.push(...mergeCrossSource(clusters, threshold));

  const canonicalIds: string[] = [];
  for (const cluster of merged) {
    const winner = [...cluster].sort((a, b) => richness(a.source) - richness(b.source))[0]!;
    canonicalIds.push(winner.id);
    for (const p of cluster) canonicalByPostingId.set(p.id, winner.id);
  }

  return { canonicalByPostingId, canonicalIds };
}

interface ClusterInfo {
  members: Posting[];
  sources: Set<string>;
  tokens: Set<string>;
  level: string;
}

function infoOf(cluster: Posting[]): ClusterInfo {
  const lead = cluster[0]!;
  const [level = "x", words = ""] = dedupTitleKey(lead.title).split("~");
  return { members: [...cluster], sources: new Set(cluster.map((p) => p.source)), tokens: new Set(words.split("-").filter(Boolean)), level };
}

function mergeCrossSource(clusters: Posting[][], threshold: number): Posting[][] {
  if (clusters.length === 1) return clusters;
  const result: ClusterInfo[] = [];
  for (const cluster of clusters) {
    const info = infoOf(cluster);
    const into = result.find((ex) => sameRole(ex, info, threshold));
    if (into) {
      into.members.push(...info.members);
      for (const s of info.sources) into.sources.add(s);
    } else {
      result.push(info);
    }
  }
  return result.map((r) => r.members);
}

function sameRole(a: ClusterInfo, b: ClusterInfo, threshold: number): boolean {
  for (const s of b.sources) if (a.sources.has(s)) return false; // one board, two reqs
  if (a.level !== b.level && a.level !== "x" && b.level !== "x") return false;
  const la = a.members[0]!;
  const lb = b.members[0]!;
  if (!compatibleLocation(la.location, lb.location)) return false;
  const sim = jaccard(a.tokens, b.tokens);
  if (sim >= 0.8) return true;
  // a looser title match needs the JD to agree too (a real embedder tells roles apart)
  if (sim < 0.5 || !la.jdEmbedding?.length || !lb.jdEmbedding?.length) return false;
  if (la.jdEmbedding.length !== lb.jdEmbedding.length) return false;
  return cosine(la.jdEmbedding, lb.jdEmbedding) >= threshold;
}

/** same place, or one side doesn't say: an aggregator often drops the city a board lists. */
function compatibleLocation(a: Posting["location"], b: Posting["location"]): boolean {
  if (a.mode === "unknown" || b.mode === "unknown") return true;
  if (a.mode === "remote" && b.mode === "remote") {
    return a.remoteGeo === b.remoteGeo || a.remoteGeo === "unknown" || b.remoteGeo === "unknown";
  }
  // every country each one names: an aggregator's "London" copy of a board's "Austin, TX;
  // London" role is the same req ({US,GB} vs {GB}); {IN} vs {US} never is
  const ca = locationCountryCodes(a);
  const cb = locationCountryCodes(b);
  if (ca.length && cb.length) {
    if (!ca.some((c) => cb.includes(c))) return false;
    // a multi-office posting's one stored city is just its first office: the shared country decides
    if (ca.length > 1 || cb.length > 1) return true;
  } else if (a.country && b.country && a.country !== b.country) {
    // an older row's region "Europe" (no country list) is compatible with a European country
    const europeVs = (x: Posting["location"], codes: string[]) => x.country === "Europe" && codes.every((c) => EUROPE_CODES.has(c));
    if (!europeVs(a, cb) && !europeVs(b, ca)) return false;
  }
  if (a.city && b.city) return cityKey(a.city) === cityKey(b.city);
  return true;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
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
