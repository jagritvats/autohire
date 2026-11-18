import { createHash, randomUUID } from "node:crypto";
import { dedup, rankPostings, type Match, type Posting, type Profile } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { localEmbedder, type Embedder } from "./embedder.js";
import { loadFxRates } from "./fx.js";

export interface RebuildResult {
  scored: number;
  ranked: number;
  excluded: number;
  topPostingIds: string[];
  /** top matches carrying an LLM narrative this rebuild (cached + newly written) */
  narrated: number;
  /** of those, how many needed a fresh LLM call */
  narratedFresh: number;
}

/** The LLM re-rank write-up for one match (§11.6) — packages/llm's RerankNarrative shape. */
export interface Narrative {
  whyFit: string;
  gap: string;
  redFlags: string[];
  /** small nudge (-10..+10) for what the deterministic score missed */
  scoreAdjust: number;
}

/**
 * The re-ranker, handed in by the caller (pipeline doesn't depend on llm): the worker
 * binds packages/llm's `rerankMatch` — HONEST_VOICE + the Evidence Bank (invariant #3).
 */
export interface Narrator {
  narrate(posting: Posting, prior: { stackNote: string | null; levelNote: string | null; redFlags: string[] }): Promise<Narrative>;
  /** model id recorded on each cached narrative */
  model: string;
  /** how many top matches to narrate (default 15) — the LLM cost bound */
  top?: number;
}

/**
 * Recompute matches for a tenant: ensure the profile is embedded, dedup active
 * postings (canonical winner wins), score the canonical set with soft weights,
 * persist matches. The LLM re-ranker (packages/llm) runs after this on the top-N.
 */
export async function rebuildMatches(
  repo: Repository,
  profile: Profile,
  opts: {
    embedder?: Embedder;
    /**
     * LLM re-ranker for the top-N. Without one, narratives already cached for unchanged
     * postings are still applied — so a settings re-rank in the web doesn't wipe them.
     */
    narrator?: Narrator;
  } = {},
): Promise<RebuildResult> {
  const embedder = opts.embedder ?? localEmbedder;
  // score salary against the store's newest cached FX rates (a no-op when none are cached)
  await loadFxRates(repo).catch(() => null);

  const active = await repo.listActivePostings();

  // ensure a profile embedding from the SAME model as the postings': it's computed once
  // and saved, so after switching LLM_PROVIDER a stale one would be compared against
  // vectors of another size (cosine over mismatched dims is noise)
  const dims = active.find((p) => p.jdEmbedding?.length)?.jdEmbedding?.length;
  if (!profile.profileEmbedding || (dims && profile.profileEmbedding.length !== dims)) {
    const text = `${profile.prefs.stackProfile.join(" ")} ${profile.prefs.targetArchetypes.join(" ")} ${profile.masterResume}`;
    profile = { ...profile, profileEmbedding: await embedder(text) };
    await repo.saveProfile(profile);
  }

  // dedup → keep canonical winners only (richest source per cluster)
  const { canonicalByPostingId } = dedup(active);
  const activeById = new Map(active.map((p) => [p.id, p]));
  for (const [pid, cid] of canonicalByPostingId) {
    const stored = activeById.get(pid)?.canonicalId ?? null;
    const want = pid === cid ? null : cid;
    // a posting that is its own canonical again (its old cluster split, or the winner went
    // stale) must drop the pointer — the browse feed hides anything that still has one.
    if (stored !== want) await repo.setCanonical(pid, want);
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

  const byId = new Map(canonical.map((p) => [p.id, p]));
  const top = opts.narrator?.top ?? DEFAULT_NARRATE_TOP;
  const n = await applyNarratives(repo, profile, matches.filter((m) => m.rulePass).sort((a, b) => b.score - a.score).slice(0, top), byId, opts.narrator);

  await repo.saveMatches(matches);

  return {
    scored: canonical.length,
    ranked: ranked.length,
    excluded: excluded.length,
    topPostingIds: ranked.slice(0, 30).map((r) => r.postingId),
    narrated: n.narrated,
    narratedFresh: n.fresh,
  };
}

const DEFAULT_NARRATE_TOP = 15;

/**
 * Attach LLM narratives to the top matches (§11.6), in place. Each narrative is cached in
 * `generation` (kind "rerank") under a hash of what it was written from — the posting's
 * content and the profile/evidence it's judged against — so every rank reuses it until
 * either changes, and a paid model is only called for new or changed top cards.
 */
async function applyNarratives(
  repo: Repository,
  profile: Profile,
  top: Match[],
  postings: Map<string, Posting>,
  narrator: Narrator | undefined,
): Promise<{ narrated: number; fresh: number }> {
  let narrated = 0;
  let fresh = 0;
  if (!top.length) return { narrated, fresh };
  const evidence = await repo.listEvidence(profile.tenantId);
  const profileKey = hash(
    JSON.stringify([profile.yoe, profile.levelBand, profile.prefs.stackProfile, profile.prefs.targetArchetypes, profile.prefs.salaryFloor, profile.prefs.currency, evidence.map((e) => e.id).sort()]),
  );
  for (const m of top) {
    const posting = postings.get(m.postingId);
    if (!posting) continue;
    const inputHash = hash(`${profileKey}|${posting.embedKey ?? hash(`${posting.title}
${posting.jdText}`)}`);
    let narrative: Narrative | null = null;
    const cached = await repo.getGeneration(profile.tenantId, posting.id, "rerank");
    if (cached?.inputHash === inputHash) {
      try {
        narrative = JSON.parse(cached.content) as Narrative;
      } catch {
        narrative = null;
      }
    }
    if (!narrative && narrator) {
      try {
        narrative = await narrator.narrate(posting, { stackNote: m.stackNote, levelNote: m.levelNote, redFlags: m.redFlags });
        await repo.saveGeneration({
          id: randomUUID(),
          tenantId: profile.tenantId,
          postingId: posting.id,
          kind: "rerank",
          prompt: "",
          content: JSON.stringify(narrative),
          model: narrator.model,
          inputHash,
          createdAt: new Date(),
        });
        fresh++;
      } catch {
        narrative = null; // provider down → the deterministic notes stand
      }
    }
    if (!narrative) continue;
    m.whyFit = narrative.whyFit || m.whyFit;
    m.gap = narrative.gap || m.gap;
    m.redFlags = [...new Set([...m.redFlags, ...(narrative.redFlags ?? [])])].slice(0, 6);
    m.score = Math.max(0, Math.min(100, Math.round(m.score + Math.max(-10, Math.min(10, narrative.scoreAdjust ?? 0)))));
    narrated++;
  }
  return { narrated, fresh };
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 24);
}
