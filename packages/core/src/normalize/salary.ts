import type { SalaryBand } from "../schema/entities.js";

/**
 * Direct salary extraction from JD text — step 1 of the cascade (§11.4), confidence
 * "high". Handles LPA / USD / k-notation / ranges. Returns null band when nothing
 * parseable, so the Enricher cascade can fall through to Adzuna/levels.fyi.
 */

interface RawNumberMatch {
  value: number;
  currency: string;
}

const CURRENCY_HINTS: Array<[RegExp, string]> = [
  // `\brs\.?` (word-boundary) so "Yrs"/"hrs" don't false-match INR; `lacs?` covers
  // Naukri's "N-M Lacs P.A." phrasing (the dominant Indian-board CTC format).
  [/₹|\brs\.?|inr|lpa|lakhs?|lacs?|crore/i, "INR"],
  [/\$|usd|dollars?/i, "USD"],
  [/€|eur|euros?/i, "EUR"],
  [/£|gbp|pounds?/i, "GBP"],
];

function detectCurrency(text: string): string {
  for (const [re, cur] of CURRENCY_HINTS) if (re.test(text)) return cur;
  return "USD";
}

/** "12 LPA" → 1200000 ; "$120k" → 120000 ; "1.2 crore" → 12000000 */
function scaleToken(numStr: string, suffix: string, currency: string): number {
  let n = parseFloat(numStr.replace(/,/g, ""));
  const s = suffix.toLowerCase();
  if (/lpa|lakh|lac/.test(s)) n *= 100_000;
  else if (/crore|cr\b/.test(s)) n *= 10_000_000;
  else if (/\bk\b/.test(s)) n *= 1_000;
  else if (/\bm\b|million/.test(s)) n *= 1_000_000;
  else if (currency === "INR" && n < 1000) n *= 100_000; // bare "20" in an INR ctx = 20 LPA
  return Math.round(n);
}

const RANGE_RE =
  /(?:₹|\$|€|£|rs\.?|inr|usd|eur|gbp)?\s*([\d.,]+)\s*(lpa|lakhs?|lacs?|crore|cr|k|m|million)?\s*(?:-|–|—|to)\s*(?:₹|\$|€|£)?\s*([\d.,]+)\s*(lpa|lakhs?|lacs?|crore|cr|k|m|million)?/gi;
const SINGLE_RE =
  /(?:₹|\$|€|£|rs\.?|inr|usd|eur|gbp)\s*([\d.,]+)\s*(lpa|lakhs?|lacs?|crore|cr|k|m|million)?/gi;

export function extractSalaryFromText(text: string): SalaryBand | null {
  if (!text) return null;
  const currency = detectCurrency(text);

  // try ranges first (more specific)
  RANGE_RE.lastIndex = 0;
  const rm = RANGE_RE.exec(text);
  if (rm && rm[1] && rm[3]) {
    const suffix = rm[4] || rm[2] || "";
    const min = scaleToken(rm[1], rm[2] || suffix, currency);
    const max = scaleToken(rm[3], suffix, currency);
    if (plausible(min, currency) && plausible(max, currency) && max >= min) {
      return { min, max, currency, source: "jd_direct", confidence: "high" };
    }
  }

  // single figure → treat as a soft floor
  SINGLE_RE.lastIndex = 0;
  const sm = SINGLE_RE.exec(text);
  if (sm && sm[1]) {
    const v = scaleToken(sm[1], sm[2] || "", currency);
    if (plausible(v, currency)) {
      return { min: v, max: null, currency, source: "jd_direct", confidence: "medium_high" };
    }
  }
  return null;
}

/** Reject parses that are obviously not a salary (a "2024" year, a "401k", etc.). */
function plausible(n: number, currency: string): boolean {
  if (currency === "INR") return n >= 200_000 && n <= 200_000_000;
  return n >= 20_000 && n <= 2_000_000;
}
