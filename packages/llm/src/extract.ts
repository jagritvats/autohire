import {
  evidenceOriginFor,
  extractSkillsStrict,
  groundDraft,
  matchSkillToken,
  normalizeForMatch,
  parseDateToken,
  type Contact,
  type EvidenceDraft,
  type ResumeDraft,
  type ResumeRole,
} from "@jobflow/core";
import { isOfflineProvider, type LlmProvider } from "./provider.js";

/**
 * Optional LLM-assisted résumé extraction (§ onboarding). The deterministic parser
 * (`parseResume`) is the baseline; a model only FILLS GAPS — layouts the parser can't
 * read (two-column PDFs, unusual role headers). Its output is never trusted: everything
 * passes `groundDraft`, which drops anything not present in the source text, and is then
 * merged only where the baseline is empty (invariant #3). Offline/echo → baseline as is.
 *
 * This is extraction, not generation, so HONEST_VOICE (a writing-voice prompt) doesn't
 * apply; the EXTRACT-ONLY prompt below is stricter: copy spans, never compose.
 */

export const EXTRACT_ONLY = `You extract structured data from a résumé. You are a PARSER, not a writer.
Hard rules:
- Copy text VERBATIM from the résumé: same words, same numbers, same order. Never paraphrase, summarise, translate, correct or improve.
- Never infer or guess. If a field is not explicitly in the résumé, return "" (or [] / null).
- Never add skills, employers, titles, dates, metrics or links that are not written in the résumé.
- Dates: copy the month/year the résumé gives as "YYYY-MM" (or "YYYY" if only a year is given); end is null with current=true only when the résumé says Present/Current.
- Return ONLY a JSON object, no commentary.`;

const SHAPE = `{
  "contact": { "firstName": "", "lastName": "", "email": "", "phone": "", "linkedin": "", "github": "", "portfolio": "" },
  "headline": "the title line under the name, verbatim, or empty",
  "summary": "the summary/profile paragraph, verbatim, or empty",
  "skills": ["each skill exactly as listed"],
  "locations": ["the candidate's location as written"],
  "roles": [{ "title": "", "company": "", "start": "YYYY-MM", "end": "YYYY-MM or null", "current": false, "bullets": ["each bullet verbatim"] }],
  "evidence": [{ "project": "employer or project name as written", "headline": "one bullet, verbatim", "detail": "the other bullets of the same entry, verbatim, newline-separated", "metric": "numbers copied verbatim from those bullets, or empty" }]
}`;

/** Largest résumé text we send (real résumés are 3–15k chars). */
const MAX_SOURCE_CHARS = 24_000;

// ── defensive coercion of whatever came back ──
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The first balanced-looking JSON object in a reply (code fences / chatter tolerated). */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Model JSON → a candidate ResumeDraft (unverified — `groundDraft` decides what stays). */
export function candidateFromModel(json: Record<string, unknown>, baseline: ResumeDraft, sourceText: string): ResumeDraft {
  const c = obj(json.contact);
  const contact: Partial<Contact> = {};
  for (const k of ["firstName", "lastName", "email", "phone", "linkedin", "github", "portfolio"] as const) {
    const v = str(c[k]);
    if (v) contact[k] = v;
  }
  const canonical: string[] = [];
  const unrecognized: string[] = [];
  for (const s of arr(json.skills).map(str).filter(Boolean)) {
    const m = matchSkillToken(s);
    if (m) {
      if (!canonical.includes(m)) canonical.push(m);
    } else if (!unrecognized.some((u) => u.toLowerCase() === s.toLowerCase())) unrecognized.push(s);
  }
  const roles: ResumeRole[] = arr(json.roles)
    .map(obj)
    .map((r) => {
      const current = r.current === true;
      return {
        title: str(r.title),
        company: str(r.company),
        start: parseDateToken(str(r.start)),
        end: current ? null : parseDateToken(str(r.end)),
        current,
        bullets: arr(r.bullets).map(str).filter(Boolean),
        levelBand: null,
        archetype: "other" as const,
      };
    })
    .filter((r) => r.title || r.company);
  const origin = evidenceOriginFor(baseline.format);
  const evidence: EvidenceDraft[] = arr(json.evidence)
    .map(obj)
    .map((e) => ({
      project: str(e.project),
      headline: str(e.headline),
      detail: str(e.detail),
      metric: str(e.metric) || null,
      tags: extractSkillsStrict(`${str(e.headline)}\n${str(e.detail)}`),
      origin,
      span: null,
      selected: true,
    }))
    .filter((e) => e.headline);
  return {
    ...baseline,
    provenance: "llm_assisted",
    text: sourceText,
    contact,
    headline: str(json.headline),
    summary: str(json.summary),
    skills: { canonical, unrecognized },
    roles,
    locations: arr(json.locations).map(str).filter(Boolean),
    evidence,
    warnings: [],
  };
}

const evidenceKey = (e: Pick<EvidenceDraft, "project" | "headline">) => `${normalizeForMatch(e.project)}|${normalizeForMatch(e.headline)}`;

/**
 * Ask the cheap model to extract, ground the reply against `sourceText`, and merge it into
 * `baseline` only where the baseline is empty (evidence: add grounded entries the baseline
 * lacks). Never throws — a failed call returns the baseline with a warning.
 */
export async function extractResumeAssisted(
  llm: LlmProvider,
  sourceText: string,
  baseline: ResumeDraft,
  opts: { now?: Date } = {},
): Promise<ResumeDraft> {
  if (isOfflineProvider(llm) || !sourceText.trim()) return baseline;

  let raw: string;
  try {
    raw = await llm.complete({
      system: EXTRACT_ONLY,
      prompt: `Extract this résumé into exactly this JSON shape:\n${SHAPE}\n\nRÉSUMÉ:\n"""\n${sourceText.slice(0, MAX_SOURCE_CHARS)}\n"""`,
      task: "cheap",
      json: true,
      temperature: 0,
      maxTokens: 4000,
      retries: 1,
    });
  } catch (e) {
    return { ...baseline, warnings: [...baseline.warnings, `AI-assisted extraction failed (${(e as Error).message}) — showing the deterministic parse.`] };
  }
  const json = parseJsonObject(raw);
  if (!json) {
    return { ...baseline, warnings: [...baseline.warnings, "AI-assisted extraction returned no usable JSON — showing the deterministic parse."] };
  }

  const { draft: g, dropped } = groundDraft(candidateFromModel(json, baseline, sourceText), sourceText, { now: opts.now });
  const merged: ResumeDraft = { ...baseline, provenance: "llm_assisted", warnings: [...baseline.warnings] };

  const contact = { ...baseline.contact };
  for (const [k, v] of Object.entries(g.contact) as Array<[keyof Contact, string | undefined]>) {
    if (v && !contact[k]) contact[k] = v;
  }
  merged.contact = contact;
  if (!merged.headline) merged.headline = g.headline;
  if (!merged.summary) merged.summary = g.summary;
  merged.skills = {
    canonical: baseline.skills.canonical.length ? baseline.skills.canonical : g.skills.canonical,
    unrecognized: baseline.skills.unrecognized.length ? baseline.skills.unrecognized : g.skills.unrecognized,
  };
  if (!merged.locations.length) merged.locations = g.locations;
  if (!baseline.roles.length && g.roles.length) {
    // the roles (and what's derived from them) come from the grounded model pass
    merged.roles = g.roles;
    merged.yoe = g.yoe;
    merged.levelBand = g.levelBand;
    merged.archetypes = g.archetypes;
    merged.warnings = merged.warnings.filter((w) => !/^No roles found/.test(w));
  }
  const have = new Set(baseline.evidence.map(evidenceKey));
  const haveHeadline = new Set(baseline.evidence.flatMap((e) => [e.headline, ...e.detail.split("\n")]).map((h) => normalizeForMatch(h)).filter(Boolean));
  merged.evidence = [...baseline.evidence];
  for (const e of g.evidence) {
    if (have.has(evidenceKey(e)) || haveHeadline.has(normalizeForMatch(e.headline))) continue;
    have.add(evidenceKey(e));
    merged.evidence.push(e);
  }
  if (dropped.length) {
    merged.warnings.push(
      `The AI pass suggested ${dropped.length} thing${dropped.length > 1 ? "s" : ""} not in your résumé — dropped: ${dropped.slice(0, 8).join("; ")}${dropped.length > 8 ? "; …" : ""}`,
    );
  }
  return merged;
}
