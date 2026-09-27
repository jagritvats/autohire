import { jdForPrompt, latexToText, type ConnectedContext, type Evidence, type Posting, type Profile } from "@jobflow/core";

/**
 * The honest-voice constraint (§0.5, §4) — the direct fix for the Cartesia failure
 * mode where generation drifted into products you didn't know and tryhard framing.
 * Baked into every generation system prompt. The candidate's own material — base
 * résumé, Evidence Bank, declared skills — is the only thing a claim may rest on.
 */
export const HONEST_VOICE = `You write in the candidate's real voice. Hard rules:
- Ground EVERY claim in the candidate's own material: their base résumé, the Evidence Bank, and their declared skills. If it isn't there, do not say it.
- You may rephrase, reorder, merge, and trim their claims to fit the role. Never add employers, titles, dates, metrics, technologies, or outcomes they didn't state, and keep every number exactly as given.
- Never name-drop technologies, products, or companies the candidate hasn't actually used.
- No performative or "tryhard" framing, no buzzword stacking, no inflated superlatives.
- Prefer concrete specifics (what was built, the metric) over adjectives.
- Honest about gaps: a transferable-but-unproven skill is framed as transferable, not owned. Don't claim a requirement the material doesn't support.
- Plain, direct, technical. Short sentences. No filler like "I am passionate about".`;

/** Upper bound on base-résumé text in a prompt — generous; real résumés are 2–8k chars. */
export const MAX_RESUME_CHARS = 16_000;

/** Full name from contact, else the first line of the base résumé when it reads like a name. */
export function candidateName(profile: Profile): string {
  const c = profile.prefs.contact;
  const fromContact = [c.firstName, c.lastName].map((s) => s.trim()).filter(Boolean).join(" ");
  if (fromContact.includes(" ")) return fromContact;
  const first = (profile.masterResume ?? "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  if (/^[\p{L}.'-]+( [\p{L}.'-]+){1,3}$/u.test(first) && (!fromContact || first.startsWith(fromContact))) return first;
  return fromContact;
}

/**
 * The candidate's own material, rendered as citeable ground truth (invariant #3): the
 * base résumé (unless the caller passes it separately, e.g. as the .tex being rewritten),
 * declared skills, contact, and the About narrative (voice + motivation).
 */
export function candidateBlock(profile: Profile, opts: { resume?: boolean } = {}): string {
  const c = profile.prefs.contact;
  const lines: string[] = ["CANDIDATE MATERIAL (the candidate's own words — citeable ground truth):"];
  const name = candidateName(profile);
  const contact = [c.email, c.phone, c.linkedin, c.github, c.portfolio].map((s) => s.trim()).filter(Boolean);
  if (name) lines.push(`NAME: ${name}`);
  if (contact.length) lines.push(`CONTACT: ${contact.join(" · ")}`);
  if (profile.yoe) lines.push(`EXPERIENCE: ~${profile.yoe} years (${profile.levelBand})`);
  const skills = profile.prefs.stackProfile.map((s) => s.replace(/_/g, " "));
  if (skills.length) lines.push(`DECLARED SKILLS: ${skills.join(", ")}`);
  const resume = (profile.masterResume ?? "").trim() || (profile.resumeLatex ? latexToText(profile.resumeLatex) : "");
  if (opts.resume !== false && resume) {
    lines.push(`BASE RÉSUMÉ (text; may come from a PDF, so spacing and line wraps can be broken):\n${resume.slice(0, MAX_RESUME_CHARS)}`);
  }
  const about = (profile.aboutText ?? "").trim();
  if (about) lines.push(`ABOUT (their own narrative — use for voice and motivation):\n${about.slice(0, 3000)}`);
  return lines.length > 1 ? lines.join("\n") : "";
}

/** The target role for a prompt: title, company, detected skills, and the cleaned JD
 *  (requirements first, boilerplate dropped — see core's jdForPrompt). */
export function jdBlock(posting: Posting, maxChars = 4000): string {
  const where = [posting.location?.mode, posting.location?.city].filter(Boolean).join(" · ");
  return [
    `TARGET ROLE: ${posting.title} @ ${posting.companyName}${where ? ` (${where})` : ""}${posting.levelBand ? ` · level: ${posting.levelBand}` : ""}`,
    posting.jdSkills.length ? `SKILLS DETECTED IN THE JD: ${posting.jdSkills.map((s) => s.replace(/_/g, " ")).join(", ")}` : "",
    `JOB DESCRIPTION (requirements first; boilerplate removed):\n${jdForPrompt(posting.jdText, maxChars) || "(no description text)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Read-only imported context (GitHub / LinkedIn / YC), rendered as attributed
 * background. It's context to draw on for voice and breadth, NOT a license to invent —
 * specific claims still rest on the candidate's material. Only enabled contexts are
 * passed in. Returns "" when there are none.
 */
export function connectedContextBlock(contexts: ConnectedContext[]): string {
  const enabled = contexts.filter((c) => c.enabled && c.content.trim());
  if (!enabled.length) return "";
  const blocks = enabled.map((c) => `[${c.source.toUpperCase()}${c.label ? ` · ${c.label}` : ""}]\n${c.content.trim().slice(0, 2000)}`);
  return (
    `\nCONNECTED CONTEXT (imported from the candidate's accounts — attributed background; ` +
    `draw on it, but ground specific claims in the candidate's material):\n` +
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
