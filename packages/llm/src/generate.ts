import { z } from "zod";
import type { Evidence, Posting, Profile } from "@jobflow/core";
import type { LlmProvider } from "./provider.js";
import { HONEST_VOICE, evidenceBlock, selectEvidence } from "./prompts.js";

/**
 * Evidence-grounded generation (§4). Resume bullets + application answers, every
 * claim cited to the Evidence Bank, honest-voice constraints enforced. This is the
 * "max prep, no hallucination" surface.
 */

// ── resume tailoring: 3 strategy variants per role (§4) ──
const ResumeVariants = z.object({
  yc_startup: z.array(z.string()),
  enterprise: z.array(z.string()),
  product: z.array(z.string()),
  atsKeywordCoverage: z.number().min(0).max(1),
  missingKeywords: z.array(z.string()).default([]),
});
export type ResumeVariants = z.infer<typeof ResumeVariants>;

export async function tailorResume(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
): Promise<ResumeVariants> {
  const relevant = selectEvidence(evidence, posting.jdSkills, 6);
  const prompt = `Tailor resume bullets to this JD using ONLY the evidence. Produce 3 strategy variants
(yc_startup: scrappy/impact, enterprise: scale/rigor, product: user/outcome). 3-4 bullets each.
Then compute ATS keyword coverage vs the JD skills and list missing keywords the candidate
genuinely has evidence for but didn't surface.

JD: ${posting.title} @ ${posting.companyName}
JD skills: ${posting.jdSkills.join(", ")}
JD excerpt: ${posting.jdText.slice(0, 1500)}

EVIDENCE BANK:
${evidenceBlock(relevant)}

Return JSON: { "yc_startup": [..], "enterprise": [..], "product": [..], "atsKeywordCoverage": 0..1, "missingKeywords": [..] }`;

  const raw = await llm.complete({
    system: `${HONEST_VOICE}\nYou tailor resumes. Each bullet maps to a specific evidence entry; never invent.`,
    prompt,
    task: "strong",
    json: true,
    maxTokens: 1200,
  });
  try {
    return ResumeVariants.parse(JSON.parse(extractJson(raw)));
  } catch {
    return {
      yc_startup: relevant.map((e) => `${e.headline} — ${e.metric ?? e.detail}`),
      enterprise: relevant.map((e) => `${e.headline} (${e.project})`),
      product: relevant.map((e) => e.detail),
      atsKeywordCoverage: coverage(profile.prefs.stackProfile, posting.jdSkills),
      missingKeywords: posting.jdSkills.filter((s) => !profile.prefs.stackProfile.includes(s)),
    };
  }
}

// ── application answers ("Why X?", "hardest problem") ──
export async function answerQuestion(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  question: string,
): Promise<string> {
  const relevant = selectEvidence(evidence, posting.jdSkills, 5);
  const prompt = `Answer this application question for ${posting.companyName}'s ${posting.title} role.
Ground every specific claim in the evidence. No name-dropping the company's products you can't
actually speak to; if you reference the company, only use what's in the JD excerpt.

QUESTION: ${question}

JD excerpt: ${posting.jdText.slice(0, 1200)}

EVIDENCE BANK:
${evidenceBlock(relevant)}

Write 120-180 words, first person, the candidate's plain technical voice.`;

  return llm.complete({
    system: `${HONEST_VOICE}\nYou draft honest application answers in the candidate's voice.`,
    prompt,
    task: "strong",
    maxTokens: 400,
    temperature: 0.4,
  });
}

function coverage(owned: string[], jd: string[]): number {
  if (!jd.length) return 1;
  const set = new Set(owned);
  return jd.filter((s) => set.has(s)).length / jd.length;
}
function extractJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : "{}";
}
