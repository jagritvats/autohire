import type { ExperienceRange } from "../schema/entities.js";

/**
 * Deterministic years-of-experience extraction (§11.2) — NO per-job LLM. Pulls every
 * "N years"-style mention out of a JD and aggregates them into one overall min–max
 * band. The value is in *ranking* (a soft seniority signal), so the bar for a match
 * is high and the bar for a false positive is higher: version numbers, calendar
 * years ("2023"), "24/7", phone digits, "3 months", and "founded 5 years ago" must
 * NOT read as an experience requirement.
 *
 * Aggregation: overall.min = the smallest lower bound seen, overall.max = the largest
 * upper bound seen. So "2 yrs Java, 3 years backend" → {min:2, max:3}; "3+ years" →
 * {min:3, max:null}; "2-4 years" → {min:2, max:4}.
 */

// A single "<number>[-<number>][+] year(s)/yr(s)/yoe" mention. Numbers are 1–2 digits
// (+optional single decimal) so calendar years like 2023 can never bind.
const YEARS_TOKEN =
  /\b(\d{1,2}(?:\.\d)?)\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?))?\s*(\+)?\s*(?:years?|yrs?|yoe)\b/gi;

// A lower-bound qualifier immediately before the number → open-ended ("min 3 years").
const LOWER_QUAL = /(?:minimum|min\.?|at\s*least|atleast|over|more than|upwards? of|greater than|>=?)\s*(?:of\s+)?$/i;
// An upper-bound qualifier → capped ("up to 4 years").
const UPPER_QUAL = /(?:up\s*to|under|less than|no more than|max(?:imum)?|at most|<=?)\s*(?:of\s+)?$/i;
// Context that means the number is NOT a requirement ("over the past 5 years").
const REJECT_BEFORE = /(?:past|last|next|previous|prior|coming|for the|in the|over the|within(?:\s+the)?\s+last|every)\s*$/i;
// Trailing context that means age / history, not a requirement ("5 years ago/old").
const REJECT_AFTER = /^\s*(?:ago|old)\b/i;

const MAX_PLAUSIBLE_YEARS = 40;

export function parseExperience(jdText: string): ExperienceRange {
  const text = jdText ?? "";
  const mins: number[] = [];
  const maxs: number[] = [];

  YEARS_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = YEARS_TOKEN.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(YEARS_TOKEN.lastIndex, YEARS_TOKEN.lastIndex + 8);
    if (REJECT_BEFORE.test(before) || REJECT_AFTER.test(after)) continue;

    let n1 = Number(m[1]);
    let n2 = m[2] != null ? Number(m[2]) : null;
    const plus = m[3] === "+";
    if (!Number.isFinite(n1) || n1 < 0 || n1 > MAX_PLAUSIBLE_YEARS) continue;
    if (n2 != null && (!Number.isFinite(n2) || n2 > MAX_PLAUSIBLE_YEARS)) n2 = null;
    if (n2 != null && n2 < n1) [n1, n2] = [n2, n1]; // tolerate "5-3 years"

    if (n2 != null) {
      mins.push(n1);
      maxs.push(n2);
    } else if (plus || LOWER_QUAL.test(before)) {
      mins.push(n1); // open-ended lower bound
    } else if (UPPER_QUAL.test(before)) {
      maxs.push(n1); // capped upper bound
    } else {
      mins.push(n1); // a plain "N years" pins both ends
      maxs.push(n1);
    }
  }

  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
  };
}
