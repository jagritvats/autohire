import type { EvidenceOrigin, RoleArchetype } from "../schema/enums.js";
import type { ResumeDraft, ResumeFormat, ResumeRole } from "../schema/resume.js";
import { parseTitle } from "../normalize/titles.js";
import { parseContact, looksLikeName } from "./contact.js";
import { draftEvidence } from "./evidence.js";
import { parseRoles } from "./roles.js";
import { sectionLines, splitSections } from "./sections.js";
import { parseSkillLines, skillsInText } from "./skills.js";
import { latexResumeToText, normalizeResumeText, stripMarkdown } from "./text.js";
import { estimateYoe, inferLevelBand } from "./yoe.js";
import { monthIndex } from "./dates.js";
// a function-only cycle (importers → buildDraft, parseResume → jsonResumeToDraft) is safe
import { jsonResumeToDraft } from "./importers.js";

/**
 * Deterministic résumé → ResumeDraft (§ onboarding). The draft is what the review screen
 * shows: contact, roles, skills, YoE/level with their basis, and Evidence Bank drafts —
 * every value copied from the candidate's own file (invariant #3). Nothing here calls a
 * model; `extractResumeAssisted` (llm) can only fill gaps, through `groundDraft`.
 */
export interface ParseResumeOptions {
  format?: ResumeFormat;
  /** original LaTeX source (format "latex"); `text` may then be anything */
  latex?: string;
  /** "today" for Present-dated roles — pass a fixed date in tests */
  now?: Date;
}

/** Which Evidence origin a format's drafts carry. */
export function evidenceOriginFor(format: ResumeFormat): EvidenceOrigin {
  return format === "json_resume" ? "json_resume" : format === "linkedin" ? "linkedin" : "resume";
}

/** Roles' distinct archetypes, most recent first ("other" left out). */
export function archetypesOf(roles: ResumeRole[]): RoleArchetype[] {
  const rec = (r: ResumeRole) => (r.current ? Infinity : r.end ? monthIndex(r.end, "end") : r.start ? monthIndex(r.start, "start") : -1);
  const out: RoleArchetype[] = [];
  for (const r of [...roles].sort((a, b) => rec(b) - rec(a))) {
    if (r.archetype !== "other" && !out.includes(r.archetype)) out.push(r.archetype);
  }
  return out;
}

const HEADLINE_BAN = /[@/\d|·•:]|https?|\.(com|io|dev)\b/i;

interface BuildOptions {
  format: ResumeFormat;
  latex?: string;
  now?: Date;
  /** structured roles from JSON Resume / LinkedIn (more precise than re-parsing text) */
  roles?: ResumeRole[];
}

/** Shared tail of every importer: normalized text → full draft. */
export function buildDraft(rawText: string, opts: BuildOptions): ResumeDraft {
  const text = normalizeResumeText(rawText);
  const now = opts.now ?? new Date();
  const sections = splitSections(text);
  const header = sections[0]?.kind === "header" ? sections[0].lines : [];
  const { contact, locations } = parseContact(text, header.length ? header : undefined);

  const nameLine = header.find(looksLikeName);
  const headline =
    header.find((l) => l !== nameLine && !HEADLINE_BAN.test(l) && l.split(/\s+/).length <= 10 && parseTitle(l).roleArchetype !== "other") ??
    header.find((l) => l !== nameLine && !HEADLINE_BAN.test(l) && l.split(/\s+/).length <= 8 && !locations.includes(l)) ??
    "";
  const summary = sectionLines(sections, "summary").join(" ");

  const skillLines = sectionLines(sections, "skills");
  const parsedSkills = parseSkillLines(skillLines);
  const bodyText = [...sectionLines(sections, "experience"), ...sectionLines(sections, "projects")].join("\n");
  const canonical = [...parsedSkills.canonical];
  for (const s of skillsInText(bodyText)) if (!canonical.includes(s)) canonical.push(s);

  const roles = opts.roles ?? parseRoles(sectionLines(sections, "experience"));
  const yoe = estimateYoe(roles, text, now);
  const levelBand = inferLevelBand(roles, yoe);
  const evidence = draftEvidence({ roles, sections, origin: evidenceOriginFor(opts.format) });

  const warnings: string[] = [];
  if (!text.trim()) warnings.push("The file has no readable text — paste your résumé instead.");
  if (!roles.length) warnings.push("No roles found under an Experience heading — add them on the review screen.");
  else if (roles.some((r) => !r.start)) warnings.push("Some roles have no dates I could read — check them so years of experience are right.");
  if (!skillLines.length) warnings.push("No Skills section found — skills listed come from your bullets.");
  if (!contact.email) warnings.push("No email address found.");
  if (!contact.firstName) warnings.push("Couldn't tell which line is your name — fill it in.");

  return {
    format: opts.format,
    provenance: "deterministic",
    text,
    latex: opts.latex ?? "",
    contact,
    headline,
    summary,
    sections: sections.map((s) => ({ kind: s.kind, title: s.title, lines: s.lines })),
    skills: { canonical, unrecognized: parsedSkills.unrecognized },
    roles,
    locations,
    yoe,
    levelBand,
    archetypes: archetypesOf(roles),
    evidence,
    warnings,
  };
}

/**
 * Parse résumé text of a given format. LaTeX is reduced to text (preamble dropped,
 * template macros' arguments kept apart, links kept); Markdown loses its syntax but keeps
 * link targets; JSON Resume goes through `jsonResumeToDraft`.
 */
export function parseResume(input: string, opts: ParseResumeOptions = {}): ResumeDraft {
  const format = opts.format ?? "text";
  if (format === "json_resume") {
    let json: unknown;
    try {
      json = JSON.parse(input);
    } catch {
      const d = buildDraft(input, { format: "text", now: opts.now });
      return { ...d, format, warnings: ["That isn't valid JSON — parsed it as plain text.", ...d.warnings] };
    }
    return jsonResumeToDraft(json, { now: opts.now });
  }
  if (format === "latex") {
    const latex = opts.latex ?? (/\\(documentclass|begin\{document\}|section)/.test(input) ? input : "");
    return buildDraft(latex ? latexResumeToText(latex) : input, { format, latex, now: opts.now });
  }
  if (format === "markdown") return buildDraft(stripMarkdown(input), { format, now: opts.now });
  return buildDraft(input, { format, now: opts.now });
}
