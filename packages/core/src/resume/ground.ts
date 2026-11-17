import type { Contact } from "../schema/entities.js";
import type { EvidenceDraft, ResumeDraft, ResumeRole } from "../schema/resume.js";
import { parseTitle } from "../normalize/titles.js";
import { bareUrl } from "./contact.js";
import { archetypesOf } from "./parse.js";
import { skillsInText } from "./skills.js";
import { containsVerbatim, contentTokens, normalizeForMatch } from "./text.js";
import { estimateYoe, inferLevelBand } from "./yoe.js";

/**
 * The invariant-#3 gate for model-extracted résumé data. A model asked to "extract" can
 * still paraphrase, embellish a metric or add a skill the candidate never listed; this
 * keeps only what the SOURCE TEXT supports and reports every drop:
 *  - evidence: ≥ 85% of the content tokens of headline+detail occur in the source, and
 *    every number in `metric` occurs verbatim;
 *  - skills: only those that canonicalize from the source text;
 *  - contact fields, locations: verbatim substrings of the source;
 *  - roles: title and company both appear; bullets filtered like evidence; dates kept
 *    only when their year appears.
 * YoE, level and archetypes are then RECOMPUTED from the surviving roles — a model's own
 * "7 years" is never taken on trust.
 */
export interface GroundOptions {
  /** share of content tokens that must appear in the source (default 0.85) */
  threshold?: number;
  now?: Date;
}

export interface GroundResult {
  draft: ResumeDraft;
  /** human-readable list of what was removed and why */
  dropped: string[];
}

/** Share of `text`'s content tokens that occur in the source token set (1 for empty). */
export function tokenCoverage(text: string, sourceTokens: Set<string>): number {
  const toks = contentTokens(text);
  if (!toks.length) return 1;
  return toks.filter((t) => sourceTokens.has(t)).length / toks.length;
}

/** Every number in `s` ("2M" → "2", "1.5x" → "1.5", "40%" → "40"). */
function numbersIn(s: string): string[] {
  return s.match(/\d+(?:[.,]\d+)*/g) ?? [];
}

function numberInSource(n: string, normSource: string): boolean {
  const re = new RegExp(`(?<![\\d.,])${n.replace(/[.,]/g, "[.,]")}(?![\\d]|[.,]\\d)`);
  return re.test(normSource);
}

export function groundDraft(candidate: ResumeDraft, sourceText: string, opts: GroundOptions = {}): GroundResult {
  const threshold = opts.threshold ?? 0.85;
  const normSource = normalizeForMatch(sourceText);
  const sourceTokens = new Set(contentTokens(sourceText));
  const sourceSkills = skillsInText(sourceText);
  const dropped: string[] = [];
  const grounded = (s: string) => tokenCoverage(s, sourceTokens) >= threshold;
  const verbatim = (s: string) => containsVerbatim(sourceText, s);
  const short = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}…` : s);

  // contact — each field verbatim (URLs compared without protocol/www)
  const contact: Partial<Contact> = {};
  for (const [k, v] of Object.entries(candidate.contact ?? {}) as Array<[keyof Contact, string | undefined]>) {
    if (!v || !v.trim()) continue;
    const probe = ["linkedin", "github", "portfolio"].includes(k) ? bareUrl(v) : v;
    if (k === "resumePath") continue; // never from a model
    if (verbatim(probe)) contact[k] = ["linkedin", "github", "portfolio"].includes(k) ? probe : v.trim();
    else dropped.push(`contact.${k} "${short(v)}" is not in the résumé`);
  }

  // skills — must canonicalize from the source text
  const canonical: string[] = [];
  for (const s of candidate.skills?.canonical ?? []) {
    if (sourceSkills.has(s)) {
      if (!canonical.includes(s)) canonical.push(s);
    } else dropped.push(`skill "${s}" is not in the résumé`);
  }
  const unrecognized: string[] = [];
  for (const s of candidate.skills?.unrecognized ?? []) {
    if (verbatim(s)) unrecognized.push(s);
    else dropped.push(`skill "${short(s)}" is not in the résumé`);
  }

  // roles
  const roles: ResumeRole[] = [];
  for (const r of candidate.roles ?? []) {
    if (!r.title?.trim() || !verbatim(r.title) || (r.company && !verbatim(r.company))) {
      dropped.push(`role "${short([r.title, r.company].filter(Boolean).join(" @ "))}" is not in the résumé`);
      continue;
    }
    const bullets = (r.bullets ?? []).filter((b) => {
      const ok = grounded(b) && numbersIn(b).every((n) => numberInSource(n, normSource));
      if (!ok) dropped.push(`bullet "${short(b)}" under ${r.title} is not in the résumé`);
      return ok;
    });
    const yearOk = (d: string | null) => !!d && normSource.includes(d.slice(0, 4));
    const start = yearOk(r.start) ? r.start : null;
    const end = yearOk(r.end) ? r.end : null;
    if ((r.start && !start) || (r.end && !end)) dropped.push(`dates of "${short(r.title)}" are not in the résumé`);
    const t = parseTitle(r.title);
    roles.push({
      ...r,
      start,
      end,
      current: !!r.current && !!start && /\b(present|current|now|today|ongoing|till date)\b/.test(normSource),
      bullets,
      levelBand: t.levelBand,
      archetype: t.roleArchetype,
    });
  }

  // evidence
  const evidence: EvidenceDraft[] = [];
  for (const e of candidate.evidence ?? []) {
    const body = `${e.headline ?? ""}\n${e.detail ?? ""}`;
    if (!e.headline?.trim() || !grounded(body)) {
      dropped.push(`evidence "${short(e.headline ?? "")}" is not in the résumé (paraphrased or invented)`);
      continue;
    }
    const badNum = numbersIn(e.metric ?? "").find((n) => !numberInSource(n, normSource));
    if (badNum) {
      dropped.push(`evidence "${short(e.headline)}": metric "${e.metric}" is not in the résumé`);
      continue;
    }
    const undetailed = numbersIn(body).find((n) => !numberInSource(n, normSource));
    if (undetailed) {
      dropped.push(`evidence "${short(e.headline)}": the number ${undetailed} is not in the résumé`);
      continue;
    }
    const project = e.project && grounded(e.project) ? e.project : e.headline.slice(0, 60);
    evidence.push({
      ...e,
      project,
      tags: (e.tags ?? []).filter((t) => sourceSkills.has(t)),
      span: e.span && verbatim(e.span.text) ? e.span : null,
    });
  }

  const headline = candidate.headline && verbatim(candidate.headline) ? candidate.headline : "";
  if (candidate.headline && !headline) dropped.push(`headline "${short(candidate.headline)}" is not in the résumé`);
  const summary = candidate.summary && grounded(candidate.summary) ? candidate.summary : "";
  if (candidate.summary && !summary) dropped.push("summary is not in the résumé (paraphrased or invented)");
  const locations = (candidate.locations ?? []).filter((l) => {
    const ok = verbatim(l);
    if (!ok) dropped.push(`location "${short(l)}" is not in the résumé`);
    return ok;
  });
  const sections = (candidate.sections ?? []).map((s) => ({ ...s, lines: s.lines.filter((l) => verbatim(l)) }));

  const yoe = estimateYoe(roles, sourceText, opts.now ?? new Date());
  const levelBand = inferLevelBand(roles, yoe);
  const draft: ResumeDraft = {
    ...candidate,
    text: sourceText,
    contact,
    headline,
    summary,
    sections,
    skills: { canonical, unrecognized },
    roles,
    locations,
    yoe,
    levelBand,
    archetypes: archetypesOf(roles),
    evidence,
    warnings: [...(candidate.warnings ?? []), ...dropped.map((d) => `Dropped: ${d}`)],
  };
  return { draft, dropped };
}
