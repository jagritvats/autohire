import type { ConnectedContext, Evidence, Profile } from "@jobflow/core";

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

/**
 * The candidate's own base resume + "about you" — *background* grounding only.
 * The Evidence Bank stays the citeable spine (invariant #3): the model may draw on
 * this to match tone and surface context, but every *specific* claim still cites
 * evidence. Returns "" when nothing's set so the prompt isn't padded with noise.
 */
export function backgroundBlock(profile: Profile): string {
  const parts: string[] = [];
  if (profile.masterResume?.trim()) parts.push(`RESUME:\n${profile.masterResume.trim().slice(0, 2500)}`);
  if (profile.aboutText?.trim()) parts.push(`ABOUT:\n${profile.aboutText.trim().slice(0, 1500)}`);
  if (!parts.length) return "";
  return (
    `\nBACKGROUND (the candidate's own words — draw on it for voice/context, but still ` +
    `ground every specific claim in the Evidence Bank; do not invent beyond either):\n` +
    parts.join("\n\n")
  );
}

/**
 * Read-only imported context (GitHub / LinkedIn / YC), rendered as attributed
 * background. Same rule as {@link backgroundBlock}: it's context to draw on for voice
 * and breadth, NOT a license to invent — specific claims still cite the Evidence Bank.
 * Only enabled contexts are passed in. Returns "" when there are none.
 */
export function connectedContextBlock(contexts: ConnectedContext[]): string {
  const enabled = contexts.filter((c) => c.enabled && c.content.trim());
  if (!enabled.length) return "";
  const blocks = enabled.map((c) => `[${c.source.toUpperCase()}${c.label ? ` · ${c.label}` : ""}]\n${c.content.trim().slice(0, 2000)}`);
  return (
    `\nCONNECTED CONTEXT (imported from the candidate's accounts — attributed background; ` +
    `draw on it, but still ground specific claims in the Evidence Bank):\n` +
    blocks.join("\n\n")
  );
}

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
