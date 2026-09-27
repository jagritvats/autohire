import type { Posting, Profile } from "../schema/entities.js";
import { scorePosting, type ScoredMatch, type ScoreWeights, DEFAULT_WEIGHTS } from "./score.js";

export * from "./stack.js";
export * from "./score.js";
export * from "./trust.js";

/**
 * Rank a set of postings for a profile. Returns rule-passing matches sorted by
 * score, plus the excluded ones (kept, with reason, so the UI can show "hidden by
 * your floor" rather than silently dropping). This is the Matcher pre-LLM-rerank
 * stage; the re-ranker (packages/llm) takes the top-N and adds the narrative.
 */
export interface RankResult {
  ranked: ScoredMatch[];
  excluded: ScoredMatch[];
}

export function rankPostings(
  postings: Posting[],
  profile: Profile,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): RankResult {
  const scored = postings.map((p) => scorePosting(p, profile, weights));
  const ranked = scored.filter((s) => s.rulePass).sort((a, b) => b.score - a.score);
  const excluded = scored.filter((s) => !s.rulePass);
  return { ranked, excluded };
}
