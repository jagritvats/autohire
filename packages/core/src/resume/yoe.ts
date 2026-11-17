import type { LevelBand } from "../schema/enums.js";
import { LevelBandOrder } from "../schema/enums.js";
import type { ResumeRole } from "../schema/resume.js";
import { monthIndex, nowMonthIndex } from "./dates.js";

/**
 * Years of experience from the résumé's own dated roles (§11.2). Overlapping roles
 * count once (union of month intervals), internships at half weight, "Present" runs to
 * `now`. When no role is dated, a stated "N+ years of experience" is the fallback. The
 * confidence says how much of that is real coverage vs. a guess.
 */
export interface YoeEstimate {
  value: number;
  confidence: number;
  basis: string;
}
export interface LevelEstimate {
  value: LevelBand;
  confidence: number;
  basis: string;
}

const STATED_YOE = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:professional\s+|industry\s+|work\s+|hands[- ]on\s+|engineering\s+|software\s+)?(?:experience|exp\b)/i;

function isInternship(role: ResumeRole): boolean {
  return role.levelBand === "intern" || /\b(intern|internship|trainee|apprentice)\b/i.test(role.title);
}

export function estimateYoe(roles: ResumeRole[], text = "", now: Date = new Date()): YoeEstimate {
  const nowIdx = nowMonthIndex(now);
  const weights = new Map<number, number>();
  let dated = 0;
  let yearOnly = 0;
  let interns = 0;
  for (const r of roles) {
    if (!r.start) continue;
    const s = monthIndex(r.start, "start");
    const e = r.current || !r.end ? (r.current ? nowIdx : null) : monthIndex(r.end, "end");
    if (e == null || e < s || s > nowIdx) continue;
    dated++;
    if (!/-/.test(r.start) || (r.end && !/-/.test(r.end))) yearOnly++;
    const w = isInternship(r) ? 0.5 : 1;
    if (w < 1) interns++;
    // inclusive month range; a "Present" role counts through the current month
    for (let m = s; m <= Math.min(e, nowIdx); m++) weights.set(m, Math.max(weights.get(m) ?? 0, w));
  }
  const computed = Math.round(([...weights.values()].reduce((a, b) => a + b, 0) / 12) * 10) / 10;
  const stated = STATED_YOE.exec(text);
  const statedValue = stated ? Number(stated[1]) : null;

  if (dated > 0) {
    const coverage = dated / Math.max(1, roles.length);
    let confidence = 0.35 + 0.5 * coverage - (yearOnly > 0 ? 0.1 : 0);
    if (statedValue != null) confidence += Math.abs(statedValue - computed) <= 1 ? 0.1 : -0.1;
    const notes = [
      `${dated} dated role${dated > 1 ? "s" : ""}${dated < roles.length ? ` of ${roles.length}` : ""}, overlaps counted once`,
      interns ? "internships at half weight" : "",
      yearOnly ? "some dates are year-only" : "",
      statedValue != null ? `résumé states ${stated![0].trim()}` : "",
    ].filter(Boolean);
    return { value: computed, confidence: clamp(confidence), basis: notes.join("; ") };
  }
  if (statedValue != null) {
    return { value: statedValue, confidence: 0.5, basis: `stated in résumé: "${stated![0].trim()}"` };
  }
  return { value: 0, confidence: 0, basis: roles.length ? "no dated roles found" : "no roles found" };
}

/** Big-tech-ish YoE ladder (§11.2): SDE-1 ≈ 0–2, SDE-2 ≈ 2–5, senior ≈ 5–8, staff 8+. */
function bandForYoe(yoe: number): LevelBand {
  if (yoe < 2) return "junior";
  if (yoe < 5) return "mid";
  if (yoe < 8) return "senior";
  return "staff";
}

function roleRecency(r: ResumeRole): number {
  if (r.current) return Number.MAX_SAFE_INTEGER;
  if (r.end) return monthIndex(r.end, "end");
  if (r.start) return monthIndex(r.start, "start");
  return -1;
}

/**
 * Level band: the most recent non-intern role's title wins when it names a level
 * ("Senior Engineer"); otherwise the YoE ladder. Agreement between the two raises
 * confidence; a title the YoE contradicts lowers it.
 */
export function inferLevelBand(roles: ResumeRole[], yoe: YoeEstimate | number): LevelEstimate {
  const y: YoeEstimate = typeof yoe === "number" ? { value: yoe, confidence: 0.5, basis: "given" } : yoe;
  const ordered = roles
    .map((r, i) => ({ r, i }))
    .sort((a, b) => roleRecency(b.r) - roleRecency(a.r) || a.i - b.i)
    .map((x) => x.r);
  if (ordered.length && ordered.every(isInternship)) {
    return { value: "intern", confidence: 0.6, basis: "only internships listed" };
  }
  const recent = ordered.find((r) => !isInternship(r));
  const titleBand = recent?.levelBand ?? null;
  const ladder = y.confidence > 0 ? bandForYoe(y.value) : null;
  if (titleBand && titleBand !== "intern") {
    const gap = ladder ? Math.abs(LevelBandOrder[titleBand] - LevelBandOrder[ladder]) : 1;
    const confidence = gap === 0 ? 0.85 : gap === 1 ? 0.7 : 0.5;
    return { value: titleBand, confidence, basis: `most recent title "${recent!.title}"${ladder ? ` (${y.value} yrs → ${ladder})` : ""}` };
  }
  if (ladder) {
    return { value: ladder, confidence: clamp(0.3 + 0.4 * y.confidence), basis: `${y.value} years of experience` };
  }
  return { value: "mid", confidence: 0, basis: "no roles or experience found — default" };
}

function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}
