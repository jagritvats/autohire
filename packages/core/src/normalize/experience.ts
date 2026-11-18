import type { ExperienceRange } from "../schema/entities.js";

/**
 * Deterministic years-of-experience extraction (§11.2) — NO per-job LLM. Pulls every
 * "N years"-style mention out of a JD and reduces them to the BINDING requirement. The
 * value is in *ranking* (a soft seniority signal), so the bar for a match is high and
 * the bar for a false positive is higher: version numbers, calendar years ("2023"),
 * "24/7", phone digits, "3 months", "founded 5 years ago", a "2 year bond" or "20 years
 * of excellence" must NOT read as an experience requirement.
 *
 * Why this matters: titles often carry no level ("SDE", "Software Engineer") while the
 * JD says "5+ years" — and Indian recruiters screen on that number. So the years are
 * read as carefully as the title.
 *
 * Aggregation — a candidate has to clear EVERY stated bar, so:
 *   min = the LARGEST lower bound among required mentions ("3+ yrs Java, 5+ yrs overall"
 *         → 5), max = the largest upper bound. Mentions in a "preferred / nice to have"
 *   sentence only count when nothing else is stated.
 */

// A single "<number>[-<number>][+| plus] year(s)/yr(s)/yoe" mention. Numbers are 1–2
// digits (+optional single decimal) so calendar years like 2023 can never bind.
const YEARS_TOKEN =
  /\b(\d{1,2}(?:\.\d)?)\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?))?\s*(\+|plus\b)?\s*(?:years?|yrs?|yoe)\b/gi;

// "Experience: 3-5" / "Exp - 5+" / "YOE: 4" — a labelled number with no "years" word.
const LABELLED_TOKEN =
  /\b(?:(?:total|relevant|work|required)\s+)?(?:experience|exp|yoe)(?:\s+(?:required|needed|level|range))?\s*[:\-–]\s*(\d{1,2}(?:\.\d)?)\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d)?))?\s*(\+|plus\b)?(?!\s*(?:[-–—+.\d%]|to\b|plus\b|years?|yrs?|yoe|months?|mos?))/gi;
// (the lookahead also blocks backtracking to a shorter match: "10+ years" must not
//  re-match as a bare "10" — the years form is handled by YEARS_TOKEN)

// A lower-bound qualifier immediately before the number → open-ended ("min 3 years").
const LOWER_QUAL = /(?:minimum|min\.?|at\s*least|atleast|over|more than|upwards? of|greater than|>=?)\s*(?:of\s+)?$/i;
// An upper-bound qualifier → capped ("up to 4 years").
const UPPER_QUAL = /(?:up\s*to|under|less than|no more than|max(?:imum)?|at most|<=?)\s*(?:of\s+)?$/i;
// Context before the number that means it is NOT a requirement.
const REJECT_BEFORE =
  /(?:past|last|next|previous|prior|coming|for the|in the|over the|after|within(?:\s+the)?\s+last|every|(?:bond|agreement|contract|commitment|lock[- ]?in|tenure|degree|course|program(?:me)?|warranty|guarantee)\s+(?:of|for)|legacy of|history of|track record of|(?:innovating|revolutionizing|revolutionising|pioneering|been around|existed|in business)\b[^.\n]{0,20}\bfor(?:\s+(?:more than|over|nearly|almost|about|close to))?)\s*$/i;
// Trailing context that means age / history / a contract term, not a requirement.
const REJECT_AFTER =
  /^\s*(?:ago|old|older|of age|or older|(?:of\s+)?(?:full[- ]time\s+|regular\s+|formal\s+)?(?:education|schooling)\b|(?:bond|contract|commitment|lock[- ]?in|tenure|term|degree|course|program|warranty|guarantee)\b|(?:of\s+)?track record|[^.\n]{0,12}\b(?:history|legacy|in business|of (?:excellence|innovation|growth|trust|service|operations?|existence|success)))/i;
// The sentence states a preference, not a requirement.
const SOFT_CONTEXT = /\b(prefer(?:red|ably)?|nice[- ]to[- ]have|good[- ]to[- ]have|bonus|a plus|ideally|desirable|would be (?:great|nice)|advantageous)\b/i;

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
const WORD_NUMBER_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/gi;

const MAX_PLAUSIBLE_YEARS = 40;
/**
 * No real JD asks more than this as a FLOOR; above it, a "N years" is the employer's age
 * ("for more than 25 years", "We're 40 years, 20+ countries"). On a live corpus every
 * 25/30/40-year "requirement" was company boilerplate (Cisco, PayPal, Nvidia, Cadence…,
 * ~200 postings read as "not your role yet" — audit 2026-11).
 */
const MAX_PLAUSIBLE_FLOOR = 20;

interface Mention {
  lo: number | null;
  hi: number | null;
  soft: boolean;
}

export function parseExperience(jdText: string): ExperienceRange {
  const text = spellOutToDigits(jdText ?? "");
  const mentions: Mention[] = [];

  const collect = (re: RegExp, labelled: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = re.lastIndex;
      const before = text.slice(Math.max(0, start - 32), start);
      const after = text.slice(end, end + 40);
      if (!labelled && (REJECT_BEFORE.test(before) || REJECT_AFTER.test(after))) continue;

      let n1 = Number(m[1]);
      let n2 = m[2] != null ? Number(m[2]) : null;
      const plus = m[3] != null || /^\s*\+/.test(after); // "5+ years" or "5 years+"
      if (!Number.isFinite(n1) || n1 < 0 || n1 > MAX_PLAUSIBLE_FLOOR) continue;
      if (n2 != null && (!Number.isFinite(n2) || n2 > MAX_PLAUSIBLE_YEARS)) n2 = null;
      if (n2 != null && n2 < n1) [n1, n2] = [n2, n1]; // tolerate "5-3 years"

      const soft = SOFT_CONTEXT.test(sentenceAround(text, start, end));
      if (n2 != null) mentions.push({ lo: n1, hi: n2, soft });
      else if (plus || LOWER_QUAL.test(before)) mentions.push({ lo: n1, hi: null, soft });
      else if (UPPER_QUAL.test(before)) mentions.push({ lo: null, hi: n1, soft });
      else mentions.push({ lo: n1, hi: n1, soft }); // a plain "N years" pins both ends
    }
  };
  collect(YEARS_TOKEN, false);
  collect(LABELLED_TOKEN, true);

  const required = mentions.filter((x) => !x.soft);
  const pool = required.length ? required : mentions;
  const los = pool.map((x) => x.lo).filter((v): v is number => v != null);
  const his = pool.map((x) => x.hi).filter((v): v is number => v != null);
  const min = los.length ? Math.max(...los) : null;
  let max = his.length ? Math.max(...his) : null;
  if (min != null && max != null && max < min) max = null; // "3+ yrs; 1-2 yrs of Kafka" → open-ended
  return { min, max };
}

/** "five years" → "5 years", only when a year word follows closely. */
function spellOutToDigits(text: string): string {
  return text.replace(WORD_NUMBER_RE, (word, _w, offset: number) => {
    const tail = text.slice(offset + word.length, offset + word.length + 24);
    return /^\s*(?:\(\d+\)\s*)?(?:\+|plus|or more)?\s*(?:(?:-|–|to)\s*\w+\s*)?(?:years?|yrs?)\b/i.test(tail)
      ? String(WORD_NUMBERS[word.toLowerCase()])
      : word;
  });
}

/** The sentence (or bullet line) containing [start, end). */
function sentenceAround(text: string, start: number, end: number): string {
  const from = Math.max(text.lastIndexOf(".", start - 1), text.lastIndexOf("\n", start - 1)) + 1;
  const stops = [text.indexOf(".", end), text.indexOf("\n", end)].filter((i) => i >= 0);
  const to = stops.length ? Math.min(...stops) : text.length;
  return text.slice(from, to);
}
