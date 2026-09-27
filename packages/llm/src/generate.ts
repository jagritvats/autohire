import { z } from "zod";
import {
  latexBodyIssues,
  latexSectionTitles,
  latexToText,
  splitLatexDocument,
  type ConnectedContext,
  type Evidence,
  type Posting,
  type Profile,
} from "@jobflow/core";
import { isOfflineProvider, type LlmProvider } from "./provider.js";
import { ProviderError } from "./http.js";
import { HONEST_VOICE, candidateBlock, candidateName, connectedContextBlock, evidenceBlock, jdBlock, selectEvidence } from "./prompts.js";
import { BUILTIN_PREAMBLE, extractLatexBody, markdownToLatex, renderBuiltinResume } from "./latex.js";
import { looksLikeMarkdownResume, plainResumeToMarkdown, renderBuiltinResumeMarkdown, stripCodeFences } from "./markdown.js";

/**
 * Grounded generation (§4): tailored résumés (bullets / Markdown / LaTeX), cover letters,
 * and application answers. Every claim rests on the candidate's own material — base
 * résumé, Evidence Bank, declared skills — under HONEST_VOICE (invariant #3).
 *
 * Failure policy: with the offline echo provider, documents come from deterministic
 * builders that format the candidate's own résumé *untailored* (source "builtin"). With a
 * real model, a failure or unusable output throws a ProviderError with a readable message
 * + detail — it is never silently swapped for a template.
 */

/** A generated résumé document. `builtin` = deterministic and NOT tailored. */
export interface TailoredDoc {
  text: string;
  source: "llm" | "builtin";
  /** non-fatal notes for the reviewer (e.g. a section the rewrite dropped). */
  warnings: string[];
}

/** Largest imported .tex we send whole (preamble + body). Real résumés are 3–15k chars. */
const MAX_TEX_CHARS = 40_000;

/** Long documents: one retry at most — each attempt can take a couple of minutes. */
const DOC_CALL = { task: "strong", retries: 1, requireComplete: true } as const;

/** The candidate's résumé as text: the pasted/extracted text, else the .tex reduced to text. */
function resumeText(profile: Profile): string {
  return (profile.masterResume || "").trim() || (profile.resumeLatex ? latexToText(profile.resumeLatex) : "");
}

function evidenceSection(evidence: Evidence[]): string {
  return evidence.length ? `EVIDENCE BANK (extra project detail — citeable):\n${evidenceBlock(evidence)}` : "";
}

const TAILORING_STEPS = `HOW TO TAILOR
1. Work out what this role needs most from the JD's requirements and responsibilities.
2. Rewrite bullets so the most relevant work leads. Use the JD's terminology only where the candidate's material genuinely supports it — describe what they actually built in words this reader recognizes, never claim more.
3. Reorder bullets within each entry (most relevant first) and order skills so the role's needs come first. Trim bullets that don't help for this role.
4. If there is a summary or objective, rewrite it in 2–3 lines aimed at this role.
5. Keep every job, degree, date, and section. Keep the length the same or shorter, so it fits the same number of pages.`;

const LATEX_OUTPUT_RULES = `- Escape LaTeX special characters in text (\\& \\% \\$ \\# \\_). Use LaTeX for symbols ($\\rightarrow$, $\\times$), never raw Unicode arrows or emoji.
- No markdown fences, no commentary before or after.`;

// ── résumé bullets: 3 strategy variants per role (§4) ──
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
  if (isOfflineProvider(llm)) return offlineVariants(profile, relevant, posting);

  const prompt = `Tailor résumé bullets for the target role below. Produce 3 strategy variants, 3–5 bullets each:
- yc_startup: ownership, speed, shipped impact
- enterprise: scale, reliability, rigor
- product: users, outcomes, collaboration
Each bullet restates something from the candidate's material in terms that matter for this JD: one line, strong verb first, their numbers kept exactly.
Then: atsKeywordCoverage = the fraction (0..1) of the JD's key skills and requirements your bullets cover; missingKeywords = JD skills the candidate's material supports that the bullets didn't surface.

${jdBlock(posting, 3000)}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}

Return JSON: { "yc_startup": [..], "enterprise": [..], "product": [..], "atsKeywordCoverage": 0..1, "missingKeywords": [..] }`;

  const raw = await llm.complete({
    system: `${HONEST_VOICE}\nYou tailor résumé bullets. Each bullet restates a specific item from the candidate's material; never invent.`,
    prompt,
    task: "strong",
    json: true,
    maxTokens: 1600,
    timeoutMs: 90_000,
  });
  try {
    return ResumeVariants.parse(JSON.parse(extractJson(raw)));
  } catch (e) {
    throw new ProviderError("The model returned malformed bullets — regenerate.", `${(e as Error).message}\n\n${raw.slice(0, 1500)}`, 422);
  }
}

/** No model: the candidate's own résumé bullets + evidence, ranked by JD-skill overlap. */
function offlineVariants(profile: Profile, relevant: Evidence[], posting: Posting): ResumeVariants {
  const jd = posting.jdSkills.map((s) => s.replace(/_/g, " ").toLowerCase());
  const fromResume = plainResumeToMarkdown(resumeText(profile))
    .split("\n")
    .filter((l) => l.startsWith("- ") && !l.startsWith("- **"))
    .map((l) => l.slice(2).trim());
  const fromEvidence = relevant.map((e) => `${e.headline} — ${e.metric ?? e.detail}`);
  const score = (b: string) => jd.reduce((n, s) => n + (b.toLowerCase().includes(s) ? 1 : 0), 0);
  const ranked = [...fromResume, ...fromEvidence]
    .map((b, i) => ({ b, s: score(b), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.b)
    .slice(0, 5);
  return {
    yc_startup: ranked,
    enterprise: ranked,
    product: ranked,
    atsKeywordCoverage: coverage(profile.prefs.stackProfile, posting.jdSkills),
    missingKeywords: posting.jdSkills.filter((s) => !profile.prefs.stackProfile.includes(s)),
  };
}

// ── tailored LaTeX résumé (§ Customize) ──
/**
 * A tailored .tex. The model rewrites only the document BODY; we splice it back into the
 * candidate's own preamble (or the built-in one) byte-for-byte, so styling, packages and
 * macros can't drift. The body is checked structurally (braces, environments, the
 * Start/End macro pairs of popular templates) — a cut-off reply throws instead of
 * becoming a draft that fails to compile.
 */
export async function tailorResumeLatex(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  contexts: ConnectedContext[] = [],
): Promise<TailoredDoc> {
  const base = (profile.resumeLatex ?? "").trim();
  const split = base ? splitLatexDocument(base) : null;
  if (base && !split) {
    throw new ProviderError(
      "Your LaTeX template isn't a full document (it needs \\begin{document} … \\end{document}) — fix it in Settings.",
      base.slice(0, 600),
      400,
    );
  }
  if (base.length > MAX_TEX_CHARS) {
    throw new ProviderError(`Your LaTeX template is ${base.length.toLocaleString()} characters — too large to send whole.`, "", 400);
  }

  if (isOfflineProvider(llm)) {
    const text = base
      ? `% Not tailored: no generation model is configured (Settings > Generation model).\n${base}\n`
      : resumeText(profile)
        ? markdownToLatex(plainResumeToMarkdown(resumeText(profile)))
        : renderBuiltinResume(profile, evidence, posting);
    return { text, source: "builtin", warnings: [] };
  }

  const relevant = selectEvidence(evidence, posting.jdSkills, 8);
  const prompt = split
    ? `Tailor the candidate's LaTeX résumé to the target role below.

${TAILORING_STEPS}

OUTPUT
- Output ONLY the document body: the content between \\begin{document} and \\end{document}, without those two lines and without the preamble.
- Keep the original body's structure: the same macros, environments, section order and section titles. Use only macros defined in the preamble or standard LaTeX.
${LATEX_OUTPUT_RULES}

PREAMBLE (fixed — for reference only, do not output it):
${split.preamble}

ORIGINAL BODY (rewrite this):
${split.body.trim()}

${jdBlock(posting)}

${candidateBlock(profile, { resume: false })}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}`
    : `Write the body of a one-page LaTeX résumé for the target role below, from the candidate's material.

CONTENT
- Header: their name and contact details, from the material.
- Sections, only where the material supports them: Summary (2–3 lines aimed at this role), Skills (grouped, the role's needs first), Experience (company, title, dates, 2–5 bullets each), Projects, Education.
- Lead with the work most relevant to the JD; use its terminology only where the material supports it; never claim more.

OUTPUT
- Output ONLY the body that goes between \\begin{document} and \\end{document}, without those two lines.
- The preamble below is fixed. Use \\begin{center}…\\end{center} with {\\LARGE \\textbf{Name}} for the header, \\section*{…}, \\subsection*{…}, itemize, \\textbf, \\textit, \\href{url}{text}, and \\hfill for right-aligned dates. Nothing that needs another package.
${LATEX_OUTPUT_RULES}

PREAMBLE (fixed — for reference only, do not output it):
${BUILTIN_PREAMBLE}

${jdBlock(posting)}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}`;

  const raw = await llm.complete({
    ...DOC_CALL,
    system: `${HONEST_VOICE}\nYou are an expert résumé writer who works directly in LaTeX. Your output must compile.`,
    prompt,
    maxTokens: 8000,
    timeoutMs: 180_000,
  });
  const body = extractLatexBody(raw);
  const issues = latexBodyIssues(body);
  if (issues.length) {
    throw new ProviderError(
      "The model returned an incomplete LaTeX document — regenerate.",
      `${issues.join("\n")}\n\n--- end of the model's output ---\n${body.slice(-1200)}`,
      422,
    );
  }

  const warnings: string[] = [];
  if (split) {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z]/g, "");
    const kept = new Set(latexSectionTitles(body).map(norm));
    const dropped = latexSectionTitles(split.body).filter((t) => !kept.has(norm(t)));
    if (dropped.length) warnings.push(`The rewrite dropped or renamed: ${dropped.join(", ")} — check before sending.`);
  }
  const preamble = split?.preamble ?? BUILTIN_PREAMBLE;
  return { text: `${preamble}\n${body}\n\\end{document}\n`, source: "llm", warnings };
}

// ── tailored Markdown résumé (§ Customize — the no-TeX common format) ──
/**
 * A tailored Markdown résumé. With a base résumé the model keeps its section order and
 * repairs PDF-extraction damage (broken wraps, glued dates); without one it builds a
 * clean layout from the candidate's material.
 */
export async function tailorResumeMarkdown(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  contexts: ConnectedContext[] = [],
): Promise<TailoredDoc> {
  const resume = resumeText(profile);
  if (isOfflineProvider(llm)) {
    const text = resume ? plainResumeToMarkdown(resume) : renderBuiltinResumeMarkdown(profile, evidence, posting);
    return { text, source: "builtin", warnings: [] };
  }

  const relevant = selectEvidence(evidence, posting.jdSkills, 8);
  const prompt = `Tailor the candidate's résumé to the target role below and write it as clean Markdown.
${resume ? `The base résumé text was extracted from a file: repair broken line wraps, spacing, and dates glued to names (e.g. "LimitedJuly 2023" → "Limited · July 2023"). Keep its section order.\n` : ""}
${TAILORING_STEPS}

FORMAT
# Full Name
one line of contact details separated by " · "
## Summary
## Skills — one line per group: "- **Group:** a, b, c"
## Experience — per role: "### Title — Company", then a line "_Dates · Location_", then "- " bullets
## Projects — per project: "### Name — tech", then "- " bullets
## Education
Only include sections the material supports. Output ONLY the Markdown — no fences, no commentary.

${jdBlock(posting)}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}`;

  const raw = await llm.complete({
    ...DOC_CALL,
    system: `${HONEST_VOICE}\nYou are an expert résumé writer. Output clean Markdown only.`,
    prompt,
    maxTokens: 4000,
    timeoutMs: 150_000,
  });
  const md = stripCodeFences(raw);
  if (!looksLikeMarkdownResume(md)) {
    throw new ProviderError("The model's reply wasn't a Markdown résumé — regenerate.", md.slice(0, 1500), 422);
  }
  return { text: md, source: "llm", warnings: [] };
}

// ── cover letter (§ Customize) ──
/**
 * A cover letter for the role: specifics from the candidate's material mapped to what the
 * JD asks for, company facts only from the JD, and the candidate's own note (if given) as
 * the only source of "why this company" — no invented enthusiasm.
 */
export async function writeCoverLetter(
  llm: LlmProvider,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting,
  contexts: ConnectedContext[] = [],
  note = "",
): Promise<string> {
  const relevant = selectEvidence(evidence, posting.jdSkills, 6);
  const name = candidateName(profile);
  const personal = note.trim();
  const prompt = `Write a cover letter from the candidate for the target role below.
- 250–350 words in 3–4 short paragraphs, first person, the candidate's plain technical voice.
- Open with the role and the single most relevant thing they've done for it. No "I am writing to express my interest", no flattery.
- Middle: two or three specifics from their material that answer what this JD asks for — name the need and what they did about it.
- If they clearly lack a stated requirement, leave it out or address it in one honest sentence (transferable, not owned). Never paper over it.
- About the company, use only what the JD says. ${personal ? "Use the candidate's note below for why they want this role." : "Don't invent enthusiasm or reasons for wanting to join."}
- Close with one line about being glad to talk, then sign off with their name${name ? ` (${name})` : ""}.
FORMAT: begin "Dear Hiring Team at ${posting.companyName}," (or the hiring manager's name if the JD gives one). Plain paragraphs separated by blank lines. No address block, no date, no subject line, no bracketed placeholders.
${personal ? `\nCANDIDATE'S NOTE (their own words — use it, don't embellish it):\n${personal.slice(0, 1500)}\n` : ""}
${jdBlock(posting, 3500)}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}`;

  const raw = await llm.complete({
    ...DOC_CALL,
    system: `${HONEST_VOICE}\nYou write honest, specific cover letters in the candidate's voice.`,
    prompt,
    maxTokens: 1500,
    temperature: 0.4,
    timeoutMs: 120_000,
  });
  const text = stripCodeFences(raw).trim();
  if (text.split(/\s+/).length < 60) {
    throw new ProviderError("The model returned a cover letter that's too short — regenerate.", text.slice(0, 1000), 422);
  }
  return text;
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
Ground every specific claim in the candidate's material. No name-dropping the company's products you can't
actually speak to; if you reference the company, only use what's in the job description.

QUESTION: ${question}

${jdBlock(posting, 2500)}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}

Write 120-180 words, first person, the candidate's plain technical voice.`;

  return llm.complete({
    system: `${HONEST_VOICE}\nYou draft honest application answers in the candidate's voice.`,
    prompt,
    task: "strong",
    maxTokens: 500,
    temperature: 0.4,
  });
}

// ── generic answers (no posting): "about you" blurb, "hardest problem you've solved" ──
/**
 * Like {@link answerQuestion} but not tied to a posting — for the settings drafts.
 * Selects evidence by the candidate's own stack so the strongest projects surface.
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
Ground every specific claim in the candidate's material; speak plainly in the first person.

QUESTION: ${question}

${candidateBlock(profile)}
${evidenceSection(relevant)}
${connectedContextBlock(contexts)}

Write 120-180 words, first person, the candidate's plain technical voice.`;

  return llm.complete({
    system: `${HONEST_VOICE}\nYou draft honest, reusable answers in the candidate's voice.`,
    prompt,
    task: "strong",
    maxTokens: 500,
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
