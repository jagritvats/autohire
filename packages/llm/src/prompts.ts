import type { Evidence } from "@jobflow/core";

/**
 * The honest-voice constraint (§0.5, §4) — the direct fix for the Cartesia failure
 * mode where generation drifted into products you didn't know and tryhard framing.
 * Baked into every generation system prompt. If a claim isn't in the Evidence Bank,
 * it does not get said.
 */
export const HONEST_VOICE = `You write in the candidate's real voice. Hard rules:
- Ground EVERY claim in the provided Evidence Bank. If it isn't in the evidence, do not say it.
- Never name-drop technologies, products, or companies the candidate hasn't actually used.
- No performative or "tryhard" framing, no buzzword stacking, no inflated superlatives.
- Prefer concrete specifics (what was built, the metric) over adjectives.
- Honest about gaps: a transferable-but-unproven skill is framed as transferable, not owned.
- Plain, direct, technical. Short sentences. No filler like "I am passionate about".`;

/** Render the Evidence Bank as a compact, citeable block for grounding. */
export function evidenceBlock(evidence: Evidence[]): string {
  if (!evidence.length) return "(no evidence provided)";
  return evidence
    .map(
      (e, i) =>
        `[E${i + 1}] ${e.project} — ${e.headline}\n     ${e.detail}` +
        (e.metric ? `\n     metric: ${e.metric}` : "") +
        `\n     tags: ${e.tags.join(", ")}`,
    )
    .join("\n");
}

/** Select the most relevant evidence for a target text (skills/JD) by tag overlap. */
export function selectEvidence(evidence: Evidence[], targetSkills: string[], k = 4): Evidence[] {
  const target = new Set(targetSkills.map((s) => s.toLowerCase()));
  return [...evidence]
    .map((e) => ({
      e,
      score: e.tags.reduce((acc, t) => acc + (target.has(t.toLowerCase()) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.e);
}
