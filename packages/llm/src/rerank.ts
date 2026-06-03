import { z } from "zod";
import type { Evidence, Posting, Profile } from "@jobflow/core";
import type { LlmProvider } from "./provider.js";
import { HONEST_VOICE, evidenceBlock, selectEvidence } from "./prompts.js";

/**
 * LLM re-ranker (§ Matcher + Re-ranker, §11.6). Takes the top-N soft-scored matches
 * and adds the honest narrative: why it fits, the likely gap, and real red flags.
 * The deterministic scorer already ordered them; this enriches, it doesn't reorder
 * wildly (we keep the LLM's role to explanation + a small nudge).
 */

const RerankItem = z.object({
  whyFit: z.string(),
  gap: z.string(),
  redFlags: z.array(z.string()).default([]),
  /** -10..+10 adjustment the LLM may apply for things scoring missed */
  scoreAdjust: z.number().min(-10).max(10).default(0),
});
export type RerankNarrative = z.infer<typeof RerankItem>;

export interface RerankInput {
  posting: Posting;
  /** flags the deterministic scorer already produced (stack note, level note, etc.) */
  priorNotes: { stackNote?: string | null; levelNote?: string | null; redFlags?: string[] };
}

export async function rerankMatch(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  input: RerankInput,
): Promise<RerankNarrative> {
  const relevant = selectEvidence(evidence, input.posting.jdSkills, 4);
  const p = input.posting;
  const prompt = `Evaluate this job for the candidate. Be honest — this card decides whether they apply or correctly skip.

CANDIDATE: ~${profile.yoe} YoE, band ${profile.levelBand}. Stack: ${profile.prefs.stackProfile.join(", ")}.
TARGET: ${profile.prefs.targetArchetypes.join(", ")}; floor ${profile.prefs.salaryFloor} ${profile.prefs.currency}.

EVIDENCE BANK (the only true claims you may make):
${evidenceBlock(relevant)}

JOB: ${p.title} @ ${p.companyName}
Location: ${p.location.mode} ${p.location.city ?? ""} ${p.location.country ?? ""} (remote_geo: ${p.location.remoteGeo})
Level parsed: ${p.levelBand ?? "unknown"} · Archetype: ${p.roleArchetype}
Skills in JD: ${p.jdSkills.join(", ") || "—"}
Scoring already noted: stack="${input.priorNotes.stackNote ?? ""}", level="${input.priorNotes.levelNote ?? ""}", flags=[${(input.priorNotes.redFlags ?? []).join("; ")}]
JD excerpt: ${p.jdText.slice(0, 1200)}

Return JSON: { "whyFit": "1-2 sentences, grounded in the evidence", "gap": "the honest likely gap / what to ramp", "redFlags": ["concrete risks only — comp/geo/seniority/on-call/etc"], "scoreAdjust": number -10..10 }`;

  const raw = await llm.complete({
    system: `${HONEST_VOICE}\nYou are a blunt, technical job-fit evaluator. whyFit/gap reference only the evidence.`,
    prompt,
    task: "strong",
    json: true,
    maxTokens: 500,
  });

  try {
    return RerankItem.parse(JSON.parse(extractJson(raw)));
  } catch {
    // graceful fallback to the deterministic notes
    return {
      whyFit: input.priorNotes.stackNote ?? "Backend/systems overlap.",
      gap: input.priorNotes.levelNote ?? "Confirm primary-language depth.",
      redFlags: input.priorNotes.redFlags ?? [],
      scoreAdjust: 0,
    };
  }
}

function extractJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : "{}";
}
