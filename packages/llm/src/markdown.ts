import type { Evidence, Posting, Profile } from "@jobflow/core";
import { candidateName } from "./prompts.js";

/**
 * Deterministic Markdown résumé builders (§ Customize — common/plain-text output).
 * Used when no generation model is configured (the offline echo provider): they format
 * the candidate's OWN material without tailoring, so the output is honest about being
 * untailored and never swaps the real résumé for something else. Mirrors latex.ts.
 */

/** Build a clean GitHub-flavored-Markdown résumé from structured profile + evidence. */
export function renderBuiltinResumeMarkdown(profile: Profile, evidence: Evidence[], posting?: Posting | null): string {
  const c = profile.prefs.contact;
  const name = candidateName(profile) || "Your Name";
  const contact = [c.email, c.phone, c.linkedin, c.github, c.portfolio].filter(Boolean).join(" · ");
  // the About narrative only — never raw résumé text, which starts with the header block
  const summary = (profile.aboutText || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const skills = profile.prefs.stackProfile.map((s) => s.replace(/_/g, " "));
  const bullets = evidence
    .slice(0, 8)
    .map((e) => {
      const metric = e.metric ? ` _(${e.metric})_` : "";
      return `- **${e.project}:** ${e.headline || e.project}. ${(e.detail || "").trim()}${metric}`.trimEnd();
    })
    .join("\n");

  const out: string[] = [];
  if (posting) out.push(`<!-- Built for ${posting.title} @ ${posting.companyName} (not tailored) -->`);
  out.push(`# ${name}`);
  if (contact) out.push(contact);
  if (summary) out.push(`\n## Summary\n\n${summary}`);
  if (skills.length) out.push(`\n## Skills\n\n${skills.join(", ")}`);
  out.push(`\n## Experience & Projects\n`);
  out.push(bullets || "- Add your résumé or evidence entries in Settings to populate this section.");
  return out.join("\n");
}

const SECTION_RE =
  /^(about( me)?|summary|professional summary|profile|career objective|objective|skills|technical skills|core skills|key skills|skills (and|&) tools|work experience|experience|professional experience|employment( history)?|internships?|projects|personal projects|selected projects|academic projects|education|certifications?|courses|achievements|awards|honou?rs( (and|&) awards)?|publications|leadership|activities|extracurriculars?|volunteering|interests|languages|open source|contributions|positions of responsibility)$/i;
const BULLET_RE = /^[•●▪◦‣∙·*\-–]\s+/;
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";

/** PDF extraction glues a trailing date onto the previous word ("LimitedJuly 2023",
 *  "Platform2025") — put a separator back. */
function unglue(s: string): string {
  return s
    .replace(new RegExp(`(?<=[a-z.)])(?=${MONTH} (?:19|20)\\d{2}\\b)`, "g"), " · ")
    .replace(/(?<=[A-Za-z])(?=(?:19|20)\d{2}(?:\s*[–-]|\s*$))/g, " · ");
}

function titleCase(s: string): string {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s;
}

/** Join a wrapped line onto the previous one, repairing "con-\ntributed" hyphenation. */
function joinWrapped(prev: string, next: string): string {
  return /[a-z]-$/.test(prev) && /^[a-z]/.test(next) ? prev.slice(0, -1) + next : `${prev} ${next}`;
}

/**
 * Plain résumé text (typically extracted from a PDF) → structured Markdown: first line
 * is the name, known section titles become `##`, bullet glyphs become `- `, wrapped
 * lines are re-joined, and "Label: a, b" skill lines become labelled bullets. Text that
 * already is Markdown (a .md upload) is returned unchanged. Heuristic, never lossy —
 * every input line lands somewhere in the output.
 */
export function plainResumeToMarkdown(text: string): string {
  const src = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!src) return "";
  if (/^#\s/m.test(src) && /^##\s/m.test(src)) return src;

  const lines = src.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
  const blocks: string[] = [];
  let section = "";
  let openItem = false; // the last block is a bullet a wrapped line may continue
  let lastLen = 0; // physical length of the previous line — a wrapped line runs near full width
  lines.forEach((line, i) => {
    const prevLen = lastLen;
    lastLen = line.length;
    if (i === 0) {
      blocks.push(`# ${line.replace(/^#+\s*/, "")}`);
      return;
    }
    const bare = line.replace(/:$/, "");
    if (SECTION_RE.test(bare)) {
      blocks.push(`## ${titleCase(bare)}`);
      section = bare.toLowerCase();
      openItem = false;
      return;
    }
    if (BULLET_RE.test(line)) {
      blocks.push(`- ${unglue(line.replace(BULLET_RE, ""))}`);
      openItem = true;
      return;
    }
    const label = /skill/.test(section) ? line.match(/^([^:,.]{2,48}):\s*(.+)$/) : null;
    if (label) {
      blocks.push(`- **${label[1]!.trim()}:** ${label[2]!.trim()}`);
      openItem = true;
      return;
    }
    const prev = blocks[blocks.length - 1] ?? "";
    const wrapped = prevLen >= 70 && !/[.!?:]$/.test(prev);
    const continues =
      !prev.startsWith("#") && (wrapped || /[,&/(-]$/.test(prev) || (openItem && /^[a-z]/.test(line)));
    if (continues) {
      blocks[blocks.length - 1] = joinWrapped(prev, line);
      return;
    }
    openItem = false;
    blocks.push(unglue(line).replace(/^#/, "\\#"));
  });

  // bullets sit on consecutive lines; everything else is its own paragraph
  return blocks
    .map((b, i) => (i === 0 ? b : (b.startsWith("- ") && blocks[i - 1]!.startsWith("- ") ? "\n" : "\n\n") + b))
    .join("");
}

/** Strip ```markdown / ``` fences an LLM may wrap the document in. */
export function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/** Heuristic: is this a résumé-shaped Markdown doc (not echo junk / prose)? */
export function looksLikeMarkdownResume(s: string): boolean {
  const t = s.trim();
  if (t.length < 20) return false;
  const firstLine = t.split("\n", 1)[0] ?? "";
  return /^#\s/.test(firstLine) || /\n##\s/.test(t);
}
