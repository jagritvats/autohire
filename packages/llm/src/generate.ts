import { z } from "zod";
import { isLatexDocument, type ConnectedContext, type Evidence, type Posting, type Profile } from "@jobflow/core";
import type { LlmProvider } from "./provider.js";
import { HONEST_VOICE, backgroundBlock, connectedContextBlock, evidenceBlock, selectEvidence } from "./prompts.js";
import { renderBuiltinResume, stripLatexFences } from "./latex.js";

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
  contexts: ConnectedContext[] = [],
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
${backgroundBlock(profile)}
${connectedContextBlock(contexts)}

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

// ── tailored LaTeX résumé (§ Customize) ──
/**
 * Produce a tailored .tex. If the profile has an imported base résumé, the LLM rewrites
 * THAT (keeping preamble/styling), swapping in evidence-grounded bullets; otherwise it
 * fills the built-in template. If the model returns anything that isn't a LaTeX document
 * (e.g. the offline echo provider), we fall back to the deterministic builder — so the
 * result always compiles. Evidence-grounded + HONEST_VOICE throughout (invariant #3).
 */
export async function tailorResumeLatex(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  contexts: ConnectedContext[] = [],
): Promise<string> {
  const relevant = selectEvidence(evidence, posting.jdSkills, 8);
  const base = (profile.resumeLatex ?? "").trim();
  const fallback = () => renderBuiltinResume(profile, evidence, posting);

  const prompt = base
    ? `Rewrite this candidate's LaTeX résumé to target the JD, using ONLY the evidence.
KEEP the preamble, \\usepackage lines, document structure, section order, and styling
EXACTLY — only rewrite the summary + experience/project bullet text. Do not add packages
or invent facts. Escape LaTeX special chars. Return ONLY the full LaTeX document.

BASE RÉSUMÉ (LaTeX):
${base.slice(0, 6000)}

JD: ${posting.title} @ ${posting.companyName}
JD skills: ${posting.jdSkills.join(", ")}
JD excerpt: ${posting.jdText.slice(0, 1200)}

EVIDENCE BANK:
${evidenceBlock(relevant)}
${connectedContextBlock(contexts)}`
    : `Write a clean one-page LaTeX résumé tailored to the JD using ONLY the evidence.
Use \\documentclass[11pt]{article} with only the geometry and enumitem packages (no
others, so it compiles on a stock TeX). Return ONLY the full LaTeX document.

CONTACT: ${[profile.prefs.contact.firstName, profile.prefs.contact.lastName].filter(Boolean).join(" ")} · ${profile.prefs.contact.email} · ${profile.prefs.contact.github} · ${profile.prefs.contact.linkedin}
JD: ${posting.title} @ ${posting.companyName}
JD skills: ${posting.jdSkills.join(", ")}

EVIDENCE BANK:
${evidenceBlock(relevant)}
${backgroundBlock(profile)}
${connectedContextBlock(contexts)}`;

  let raw: string;
  try {
    raw = await llm.complete({
      system: `${HONEST_VOICE}\nYou are a LaTeX résumé expert. Output must compile with pdflatex; never invent — ground every bullet in the evidence.`,
      prompt,
      task: "strong",
      maxTokens: 3000,
    });
  } catch {
    return fallback();
  }
  const tex = stripLatexFences(raw);
  return isLatexDocument(tex) ? tex : fallback();
}

// ── application answers ("Why X?", "hardest problem") ──
export async function answerQuestion(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  question: string,
  contexts: ConnectedContext[] = [],
): Promise<string> {
  const relevant = selectEvidence(evidence, posting.jdSkills, 5);
  const prompt = `Answer this application question for ${posting.companyName}'s ${posting.title} role.
Ground every specific claim in the evidence. No name-dropping the company's products you can't
actually speak to; if you reference the company, only use what's in the JD excerpt.

QUESTION: ${question}

JD excerpt: ${posting.jdText.slice(0, 1200)}

EVIDENCE BANK:
${evidenceBlock(relevant)}
${backgroundBlock(profile)}
${connectedContextBlock(contexts)}

Write 120-180 words, first person, the candidate's plain technical voice.`;

  return llm.complete({
    system: `${HONEST_VOICE}\nYou draft honest application answers in the candidate's voice.`,
    prompt,
    task: "strong",
    maxTokens: 400,
    temperature: 0.4,
  });
}

// ── generic answers (no posting): "about you" blurb, "hardest problem you've solved" ──
/**
 * Like {@link answerQuestion} but not tied to a posting — for the settings drafts.
 * Still evidence-grounded + honest-voice; selects evidence by the candidate's own
 * stack so the strongest projects surface.
 */
export async function answerGeneric(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  question: string,
  contexts: ConnectedContext[] = [],
): Promise<string> {
  const relevant = selectEvidence(evidence, profile.prefs.stackProfile, 5);
  const prompt = `Answer this for the candidate, generically (no specific company).
Ground every specific claim in the evidence; speak plainly in the first person.

QUESTION: ${question}

EVIDENCE BANK:
${evidenceBlock(relevant)}
${backgroundBlock(profile)}
${connectedContextBlock(contexts)}

Write 120-180 words, first person, the candidate's plain technical voice.`;

  return llm.complete({
    system: `${HONEST_VOICE}\nYou draft honest, reusable answers in the candidate's voice.`,
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
