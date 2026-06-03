import { randomUUID } from "node:crypto";
import { dedup, rankPostings, type Match, type Posting, type Profile } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { localEmbedder, type Embedder } from "./embedder.js";

export interface RebuildResult {
  scored: number;
  ranked: number;
  excluded: number;
  topPostingIds: string[];
}

/**
 * Recompute matches for a tenant: ensure the profile is embedded, dedup active
 * postings (canonical winner wins), score the canonical set with soft weights,
 * persist matches. The LLM re-ranker (packages/llm) runs after this on the top-N.
 */
export async function rebuildMatches(
  repo: Repository,
  profile: Profile,
  opts: { embedder?: Embedder } = {},
): Promise<RebuildResult> {
  const embedder = opts.embedder ?? localEmbedder;

  // ensure profile embedding
  if (!profile.profileEmbedding) {
    const text = `${profile.prefs.stackProfile.join(" ")} ${profile.prefs.targetArchetypes.join(" ")} ${profile.masterResume}`;
    profile = { ...profile, profileEmbedding: await embedder(text) };
    await repo.saveProfile(profile);
  }

  const active = await repo.listActivePostings();

  // dedup → keep canonical winners only (richest source per cluster)
  const { canonicalByPostingId } = dedup(active);
  for (const [pid, cid] of canonicalByPostingId) {
    if (pid !== cid) await repo.setCanonical(pid, cid);
  }
  const canonicalIds = new Set(canonicalByPostingId.values());
  const canonical: Posting[] = active.filter((p) => canonicalIds.has(p.id));

  const { ranked, excluded } = rankPostings(canonical, profile);

  const now = new Date();
  const matches: Match[] = [...ranked, ...excluded].map((s) => ({
    id: randomUUID(),
    tenantId: profile.tenantId,
    postingId: s.postingId,
    score: s.score,
    scoreBreakdown: s.breakdown,
    rulePass: s.rulePass,
    whyFit: s.flags.stack.note,
    gap: null,
    stackNote: s.flags.stack.note,
    levelNote: s.flags.levelNote,
    redFlags: s.flags.hardExclusionReason
      ? [...s.flags.redFlags, s.flags.hardExclusionReason]
      : s.flags.redFlags,
    generatedAt: now,
  }));

  await repo.saveMatches(matches);

  return {
    scored: canonical.length,
    ranked: ranked.length,
    excluded: excluded.length,
    topPostingIds: ranked.slice(0, 30).map((r) => r.postingId),
  };
}
