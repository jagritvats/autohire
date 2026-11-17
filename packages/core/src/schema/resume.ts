import { z } from "zod";
import { EvidenceOrigin, LevelBand, RoleArchetype } from "./enums.js";
import { Contact } from "./entities.js";

/**
 * A résumé import, before the user confirms it. Everything here is EXTRACTED from the
 * user's own file — the parser copies spans, it never paraphrases or infers new claims
 * (invariant #3). The LLM-assisted path is filtered through `groundDraft` so anything
 * not present in the source text is dropped and reported in `warnings`.
 */
export const ResumeFormat = z.enum([
  "pdf",
  "docx",
  "latex",
  "markdown",
  "text",
  "json_resume",
  "linkedin",
  "paste",
]);
export type ResumeFormat = z.infer<typeof ResumeFormat>;

export const SourceSpan = z.object({
  section: z.string(),
  line: z.number().int(),
  text: z.string(),
});
export type SourceSpan = z.infer<typeof SourceSpan>;

export const EvidenceDraft = z.object({
  project: z.string(),
  headline: z.string(),
  detail: z.string(),
  metric: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  origin: EvidenceOrigin.default("resume"),
  span: SourceSpan.nullable().default(null),
  selected: z.boolean().default(true),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraft>;

export const ResumeRole = z.object({
  title: z.string(),
  company: z.string(),
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
  current: z.boolean().default(false),
  bullets: z.array(z.string()).default([]),
  levelBand: LevelBand.nullable().default(null),
  archetype: RoleArchetype.default("other"),
});
export type ResumeRole = z.infer<typeof ResumeRole>;

export const ResumeSectionKind = z.enum(["header", "summary", "experience", "projects", "education", "skills", "other"]);
export type ResumeSectionKind = z.infer<typeof ResumeSectionKind>;

export const ResumeDraft = z.object({
  format: ResumeFormat,
  provenance: z.enum(["deterministic", "llm_assisted"]).default("deterministic"),
  /** the plain text everything was extracted from (becomes `masterResume`). */
  text: z.string(),
  /** original LaTeX source when imported as .tex (becomes `resumeLatex`). */
  latex: z.string().default(""),
  contact: Contact.partial().default({}),
  headline: z.string().default(""),
  summary: z.string().default(""),
  sections: z
    .array(z.object({ kind: ResumeSectionKind, title: z.string(), lines: z.array(z.string()) }))
    .default([]),
  skills: z
    .object({ canonical: z.array(z.string()).default([]), unrecognized: z.array(z.string()).default([]) })
    .default({}),
  roles: z.array(ResumeRole).default([]),
  locations: z.array(z.string()).default([]),
  yoe: z.object({ value: z.number(), confidence: z.number(), basis: z.string() }),
  levelBand: z.object({ value: LevelBand, confidence: z.number(), basis: z.string() }),
  archetypes: z.array(RoleArchetype).default([]),
  evidence: z.array(EvidenceDraft).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ResumeDraft = z.infer<typeof ResumeDraft>;
