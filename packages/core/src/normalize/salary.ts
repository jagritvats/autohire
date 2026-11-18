import type { SalaryBand } from "../schema/entities.js";
import type { SalaryBasis, SalaryConfidence, SalaryPeriod } from "../schema/enums.js";
import { toUsd } from "../salary/fx.js";
import { PERIOD_FACTOR } from "../salary/period.js";

/**
 * Direct salary extraction — step 1 of the cascade (§11.4). What a posting STATES, never a
 * model's guess (estimates live in `Posting.salaryEstimate`).
 *
 * A `high` band can hard-exclude a posting below the user's floor (invariant #4), so `high`
 * has to be earned. The currency is read from the tokens ATTACHED to the amount — never from
 * anywhere in the JD ("workplace" contains "lac", "RSUs" starts with "Rs") — and a figure in
 * JD prose only counts near a pay word. Boilerplate like "INR 150 lakh crore TPV", "2 to 5
 * years" or "raised $500k" can therefore never become a salary.
 *
 *   high         explicit currency · a range or an "up to" cap · a pay word nearby (or the
 *                source's own salary field) · an annual or monthly figure, period stated or
 *                plainly annual
 *   medium_high  explicit currency, but a single figure, no pay word, an annualised hourly/
 *                daily/weekly rate, a period we had to infer, or a bare "$" / "¥" the
 *                location doesn't pin down (only a US posting's "$" is surely USD)
 *   medium       the source's salary field with no currency, priced in the location's
 *
 * The band keeps what was STATED — `period` (year/month/week/day/hour), `basis` (base /
 * OTE / total comp) and whether equity rides on top — while `min`/`max` are annualised
 * (`PERIOD_FACTOR`) so every comparison reads one unit.
 */

/**
 * Version of the stated-salary parse. A store records the version its bands were parsed with
 * (`store_meta.salary_parse_version`); `pollAll` re-parses stored postings once when this is
 * newer, so a local install picks up an extractor fix on its next sync. BUMP IT whenever
 * `parseStatedSalary` returns something different for the same input.
 * History: 1 = stated period / basis / equity, country-resolved "$" / "kr" / "¥", inferred months.
 */
export const SALARY_PARSE_VERSION = 1;
export const SALARY_PARSE_VERSION_KEY = "salary_parse_version";

export interface SalaryParseOptions {
  /** the text is the source's own salary field (ATS/aggregator pay string), not JD prose */
  structured?: boolean;
  /** currency the posting's location implies (`currencyHintFor`) — prices an unlabeled field */
  currencyHint?: string | null;
  /**
   * ISO-2 country the posting is in — resolves "$" (CA$/AU$/NZ$/SG$/HK$/MX$, else USD), "kr"
   * (SEK/NOK/DKK/ISK) and "¥" (CNY/JPY). `null` = the location is unknown: a "$" is then read
   * as USD at reduced confidence. Omitted entirely (no location context, e.g. a unit test or a
   * typed filter) = a "$" is USD.
   */
  country?: string | null;
}

type Kind = "range" | "cap" | "floor" | "point";

interface Token {
  start: number;
  end: number;
  raw: number;
  scale: string | null;
  /** currencies written on the token, pre then post (codes, or "$" / "kr" / "¥" to resolve) */
  marks: string[];
}

interface Candidate {
  min: number | null;
  max: number | null;
  currency: string;
  confidence: SalaryConfidence;
  kind: Kind;
  period: SalaryPeriod;
  basis: SalaryBasis | null;
  equity: boolean;
}

// Written before an amount. Longer/qualified marks first so "CA$" never reads as "$".
const PRE: Array<[string, string]> = [
  ["US$", "USD"], ["USD", "USD"], ["CA$", "CAD"], ["C$", "CAD"], ["CAD", "CAD"],
  ["AU$", "AUD"], ["A$", "AUD"], ["AUD", "AUD"], ["NZ$", "NZD"], ["NZD", "NZD"],
  ["S$", "SGD"], ["SGD", "SGD"], ["HK$", "HKD"], ["HKD", "HKD"], ["R$", "BRL"], ["BRL", "BRL"],
  ["MX$", "MXN"], ["MXN", "MXN"],
  ["INR", "INR"], ["Rs.", "INR"], ["Rs", "INR"], ["₹", "INR"],
  ["EUR", "EUR"], ["€", "EUR"], ["GBP", "GBP"], ["£", "GBP"], ["CHF", "CHF"],
  ["SEK", "SEK"], ["NOK", "NOK"], ["DKK", "DKK"], ["ISK", "ISK"], ["PLN", "PLN"], ["zł", "PLN"],
  ["CZK", "CZK"], ["HUF", "HUF"], ["RON", "RON"], ["TRY", "TRY"], ["₺", "TRY"],
  ["JPY", "JPY"], ["CNY", "CNY"], ["RMB", "CNY"], ["KRW", "KRW"], ["₩", "KRW"], ["ILS", "ILS"], ["₪", "ILS"],
  ["ZAR", "ZAR"], ["AED", "AED"], ["SAR", "SAR"], ["MYR", "MYR"], ["RM", "MYR"], ["PHP", "PHP"], ["₱", "PHP"],
  ["IDR", "IDR"], ["Rp", "IDR"], ["THB", "THB"],
  ["kr.", "kr"], ["kr", "kr"], ["¥", "¥"],
  ["$", "$"], // bare dollar: resolved per candidate from the posting's country
];
// Written after an amount ("150,000 USD", "60.000 €", "45 000 kr", "15 000 zł").
const POST: Array<[string, string]> = [
  ["USD", "USD"], ["CAD", "CAD"], ["AUD", "AUD"], ["SGD", "SGD"], ["NZD", "NZD"], ["HKD", "HKD"], ["MXN", "MXN"],
  ["INR", "INR"], ["EUR", "EUR"], ["€", "EUR"], ["GBP", "GBP"], ["£", "GBP"], ["CHF", "CHF"],
  ["SEK", "SEK"], ["NOK", "NOK"], ["DKK", "DKK"], ["ISK", "ISK"], ["PLN", "PLN"], ["zł", "PLN"], ["zl", "PLN"],
  ["CZK", "CZK"], ["Kč", "CZK"], ["HUF", "HUF"], ["Ft", "HUF"], ["RON", "RON"], ["lei", "RON"], ["TRY", "TRY"],
  ["JPY", "JPY"], ["CNY", "CNY"], ["KRW", "KRW"], ["ILS", "ILS"], ["BRL", "BRL"], ["ZAR", "ZAR"], ["AED", "AED"],
  ["SAR", "SAR"], ["MYR", "MYR"], ["PHP", "PHP"], ["IDR", "IDR"], ["THB", "THB"], ["₹", "INR"],
  ["kr.", "kr"], ["kr", "kr"], ["円", "JPY"], ["元", "CNY"],
];
const CUR_OF = new Map<string, string>([...PRE, ...POST].map(([t, c]) => [t.toUpperCase(), c]));

/** the dollar a bare "$" means where the posting is (US → USD; anywhere else unknown) */
const DOLLAR_OF: Readonly<Record<string, string>> = { US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", MX: "MXN" };
const KRONA_OF: Readonly<Record<string, string>> = { SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One money-ish amount: [currency] number [scale] [currency]. Number forms: Western/Indian
 * comma grouping (150,000 · 12,00,000), European dot grouping (60.000), Swiss (120'000),
 * space grouping (45 000 — Nordic/French), plain/decimal (28, 1.2). Never glued to a word or
 * another number.
 */
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])` +
    `(?:(${PRE.map(([t]) => esc(t)).join("|")})\\s?)?` +
    String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?![\d,])|\d{1,3}(?:['’]\d{3})+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?![\d,.])|\d+(?:\.\d+)?)` +
    String.raw`(?:\s?(k|thousand|million|mn?|billion|bn?|lpa|lakhs?|lacs?|l|crores?|cr)(?!\p{L}))?` +
    `(?:\\s?(${POST.map(([t]) => esc(t)).join("|")})(?!\\p{L}))?`,
  "giu",
);

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
  lpa: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7,
};
const INR_SCALES = new Set(["lpa", "lakh", "lakhs", "lac", "lacs", "l", "crore", "crores", "cr"]);

/** "150 lakh crore", "5 million users"-style compound magnitudes are never pay. */
const COMPOUND_AFTER = /^\s*(?:crores?|cr|lakhs?|lacs?|million|billion|bn|mn|trillion)(?!\p{L})/iu;
/** between the two ends of a range; a period may sit on the first end ("$50/hr – $70/hr") */
const RANGE_SEP = /^\s*(?:\/\s*(?:yr|year|mo|month|hr|hour|h|day|wk|week)\.?)?\s*(?:-|–|—|~|to|and|until|bis|à|a)\s*$/i;

/** Words that make a nearby figure a salary. */
const PAY_WORD = /\b(salary|salaries|compensation|pay|pays|paid|ctc|stipend|remuneration|wages?|ote|on[- ]target earnings|earnings?|per annum|annual base|base (?:salary|pay|compensation)|pay (?:range|band|scale)|hiring range|package|lpa|day rate|daily rate|hourly rate|pay rate|rate of pay|gehalt|salaire|salario|wynagrodzenie|lön)\b/i;
/** Words that make a nearby figure a company metric or a one-off, not pay. */
const NOT_PAY = /\b(raised|raising|funding|funded|valuation|valued|revenue|arr|gmv|tpv|turnover|market cap\w*|series [a-f]|seed|invest\w*|customers?|users|merchants|transactions?|volume|donat\w*|prize|award)\b/i;
/** The amount directly modifies a perk / one-off / an equity grant ("$15,000 signing bonus", "$20k in RSUs"). */
const PERK_AFTER = /^\s*(?:(?:annual|yearly|one[- ]time|signing|sign[- ]on|joining|referral|relocation|learning|education|wellness|home[- ]office|wfh|internet|phone|equipment|travel|meal|health)\s+)?(?:bonus|budget|allowance|reimbursement|credits?|grant|fund)\b|^\s*(?:learning|education|wellness|home[- ]office|wfh|internet|phone|equipment)\s+stipend\b|^\s*(?:in|of|worth of)?\s*(?:rsus?|equity|stock(?:\s+options)?|esops?|share options|options)\b/i;

const CAP_BEFORE = /\b(?:up ?to|max(?:imum)?|as high as|not more than|no more than|bis zu|jusqu'à|hasta)\s*$/i;
const FLOOR_BEFORE = /\b(?:from|starting (?:at|from)|min(?:imum)?|at least|over|above|more than|ab|à partir de|desde)\s*$/i;

/** qualifiers that may sit between an amount and its period ("€5,500 gross per month") */
const QUAL = String.raw`^[\s,]*(?:(?:gross|net|brutto|netto|pre-?tax|before tax|base|fixed|ctc|salary|plus benefits|\+\s*benefits|USD|EUR|GBP|INR)[\s,]*)*`;
const PERIOD_AFTER: Array<[RegExp, SalaryPeriod]> = [
  [new RegExp(QUAL + String.raw`(?:(?:\/|per|an?|each|pro)\s*(?:hr|hour|h|stunde|std)\.?(?![a-z])|hourly\b|p\/?h\b|ph\b|stundenlohn\b|de l'heure\b|la hora\b)`, "i"), "hour"],
  [new RegExp(QUAL + String.raw`(?:(?:\/|per|a|pro)\s*(?:day|tag)\b|daily\b|day[- ]rate\b|p\/?d\b|\/d\b)`, "i"), "day"],
  [new RegExp(QUAL + String.raw`(?:(?:\/|per|a|pro)\s*(?:wk|week|woche)\b|weekly\b|p\/?w\b)`, "i"), "week"],
  [
    new RegExp(
      QUAL +
        String.raw`(?:(?:\/|per|a|pro|par|al)\s*(?:mo|mth|month|monat|mois|mes|maand|mån(?:ad)?|m)\.?(?![a-z])|por m[eê]s\b|monthly\b|monatlich\b|mensuel(?:le)?\b|mensual\b|mensais\b|miesięcznie|mies\.|p\.?\s?m\.?(?![a-z])|pcm\b|a month\b)`,
      "iu",
    ),
    "month",
  ],
  [
    new RegExp(
      QUAL +
        String.raw`(?:(?:\/|per|an?|pro|par|al)\s*(?:yr|year|annum|jahr|an|año|jaar|år|y)\.?(?![a-z])|annually\b|annual\b|yearly\b|jährlich\b|annuel(?:le)?\b|anual\b|rocznie|p\.?\s?a\.?(?![a-z])|pa\b)`,
      "iu",
    ),
    "year",
  ],
];
const PERIOD_BEFORE: Array<[RegExp, SalaryPeriod]> = [
  [/\b(?:hourly|per hour|hour(?:ly)? rate)\b/gi, "hour"],
  [/\b(?:day rate|daily rate|per day)\b/gi, "day"],
  [/\b(?:weekly|per week)\b/gi, "week"],
  [/\b(?:monthly|per month|month(?:ly)? (?:salary|stipend|ctc|pay))\b/gi, "month"],
  [/\b(?:annual(?:ly)?|per annum|yearly)\b/gi, "year"], // "CTC" alone is annual by default, but it doesn't vouch for a band too small to be a year
];

const BASIS: Array<[RegExp, SalaryBasis]> = [
  [/\b(?:ote|on[- ]target(?: earnings)?)\b/gi, "ote"],
  [/\b(?:total (?:comp(?:ensation)?|rewards?|cash|package|target cash)|tc)\b/gi, "total"],
  [/\bbase(?: salary| pay| compensation| range)?\b/gi, "base"],
];
/** equity riding ON TOP of the figure ("+ equity", "plus stock options", "• 0.1% – 0.5%") */
const EQUITY_AFTER = /^[\s,.()]*(?:base\s*)?(?:(?:\+|plus|and|&|with|as well as)\s*(?:an?\s+)?(?:generous |meaningful |competitive |significant |early[- ]stage )?(?:equity|stock|rsus?|esops?|share options|options)\b|•\s*(?:\d+(?:\.\d+)?%|offers equity))/i;

/** ₹3 L/yr (₹25k/month): below it, an INR figure with no stated period may be a month's pay */
const INR_ANNUAL_MIN = 300_000;

const RANK: Record<SalaryConfidence, number> = { high: 3, medium_high: 2, medium: 1, low: 0 };
const KIND_RANK: Record<Kind, number> = { range: 2, cap: 1, floor: 0, point: 0 };

export function extractSalaryFromText(input: string, opts: SalaryParseOptions = {}): SalaryBand | null {
  if (!input) return null;
  const text = toPlainText(input);
  const tokens = scanAmounts(text);
  const candidates: Candidate[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1];
    if (b && RANGE_SEP.test(text.slice(a.end, b.start))) {
      const c = buildCandidate(text, a, b, opts);
      if (c) candidates.push(c);
      i++; // both ends consumed
      continue;
    }
    const c = buildCandidate(text, a, null, opts);
    if (c) candidates.push(c);
  }
  if (!candidates.length) return null;

  // strongest evidence wins; equally strong same-currency bands are geo tiers of one role
  // ("SF $180–220k · Remote $150–190k") → report their union, never silently pick one
  const rank = (c: Candidate) => RANK[c.confidence] * 10 + KIND_RANK[c.kind];
  const best = Math.max(...candidates.map(rank));
  let top = candidates.filter((c) => rank(c) === best);
  // "Base $140–160k; OTE $280–320k": the base band is the salary; OTE rides on commission
  if (top.some((c) => c.basis === "base") && top.some((c) => c.basis === "ote" || c.basis === "total")) {
    top = top.filter((c) => c.basis === "base");
  }
  const first = top[0]!;
  const same = top.filter((c) => c.currency === first.currency && c.period === first.period && c.basis === first.basis);
  const mins = same.map((c) => c.min).filter((n): n is number => n != null);
  const maxs = same.map((c) => c.max).filter((n): n is number => n != null);
  let min = mins.length ? Math.min(...mins) : null;
  let max = maxs.length ? Math.max(...maxs) : null;
  if (min != null && max != null && max / min > 5) {
    // too far apart to be one role's tiers — trust the first band alone
    min = first.min;
    max = first.max;
  }
  return {
    min,
    max,
    currency: first.currency,
    source: "jd_direct",
    confidence: first.confidence,
    period: first.period,
    basis: first.basis,
    equity: candidates.some((c) => c.equity) || (!!opts.structured && /(?<!\bno\s)\bequity\b|•\s*\d+(?:\.\d+)?%/i.test(text)),
  };
}

function scanAmounts(text: string): Token[] {
  const out: Token[] = [];
  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text))) {
    const [whole, pre, num, scale, post] = m;
    if (!num) continue;
    const marks = [pre, post].filter((x): x is string => !!x).map((x) => CUR_OF.get(x.toUpperCase()) ?? x);
    out.push({ start: m.index, end: m.index + whole.length, raw: parseNumber(num), scale: scale?.toLowerCase() ?? null, marks });
  }
  return out;
}

function parseNumber(s: string): number {
  if (/^\d{1,3}(?:\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, "")); // 60.000 (EU grouping)
  return Number(s.replace(/[,'’ \u00a0\u202f]/g, ""));
}

/** Resolve "$" / "kr" / "¥" from where the posting is. `ambiguous` = not pinned down. */
function resolveMark(mark: string, opts: SalaryParseOptions): { currency: string | null; ambiguous: boolean } {
  const country = opts.country === undefined ? undefined : opts.country?.toUpperCase() ?? null;
  if (mark === "$") {
    if (country === undefined) {
      // no location context given: the legacy hint, else USD
      const hint = opts.currencyHint?.toUpperCase();
      if (hint && hint !== "USD" && Object.values(DOLLAR_OF).includes(hint)) return { currency: hint, ambiguous: true };
      return { currency: "USD", ambiguous: false };
    }
    const dollar = country ? DOLLAR_OF[country] : undefined;
    if (dollar === "USD") return { currency: "USD", ambiguous: false };
    // a CA/AU/NZ/SG/HK/MX posting's "$" is probably local; anywhere else (or unknown) probably USD
    return { currency: dollar ?? "USD", ambiguous: true };
  }
  if (mark === "kr") {
    const k = country ? KRONA_OF[country] : undefined;
    const hint = opts.currencyHint?.toUpperCase();
    if (k) return { currency: k, ambiguous: false };
    if (hint && Object.values(KRONA_OF).includes(hint)) return { currency: hint, ambiguous: false };
    return { currency: null, ambiguous: true }; // a krona we can't name is never priced
  }
  if (mark === "¥") {
    if (country === "CN") return { currency: "CNY", ambiguous: false };
    if (country === "JP") return { currency: "JPY", ambiguous: false };
    return { currency: "JPY", ambiguous: true };
  }
  return { currency: mark, ambiguous: false };
}

function buildCandidate(text: string, a: Token, b: Token | null, opts: SalaryParseOptions): Candidate | null {
  const structured = !!opts.structured;
  const start = a.start;
  const end = (b ?? a).end;
  if (COMPOUND_AFTER.test(text.slice(end)) || (b && COMPOUND_AFTER.test(text.slice(a.end)))) return null;
  if (PERK_AFTER.test(text.slice(end, end + 40))) return null;

  // ── currency: a code / qualified mark on either end beats an ambiguous one; an Indian unit
  //    (LPA, lakh, crore) is itself a currency mark ──
  const marks = [...a.marks, ...(b?.marks ?? [])];
  const scales = [a.scale, b?.scale].filter((s): s is string => !!s);
  const AMBIG = new Set(["$", "kr", "¥"]);
  const definite = marks.find((c) => !AMBIG.has(c));
  let currency: string | null = definite ?? null;
  let ambiguous = false;
  if (!currency && marks.length) {
    const r = resolveMark(marks[0]!, opts);
    if (!r.currency) return null;
    currency = r.currency;
    ambiguous = r.ambiguous;
  }
  if (!currency && scales.some((s) => INR_SCALES.has(s))) currency = "INR";
  let explicit = currency != null;
  if (!currency) {
    // JD prose: a number with no currency is never pay ("2 to 5 years", "150+ engineers")
    if (!structured || !opts.currencyHint) return null;
    currency = opts.currencyHint.toUpperCase();
    explicit = false;
  }

  // ── values: a scale written once covers both ends ("28-36 LPA", "USD 150-200K") ──
  const scaleA = a.scale ?? (b?.scale && a.raw < 1000 ? b.scale : null);
  const scaleB = b ? (b.scale ?? (a.scale && b.raw < 1000 ? a.scale : null)) : null;
  let lo = scaleValue(a.raw, scaleA, currency, structured);
  let hi = b ? scaleValue(b.raw, scaleB, currency, structured) : null;
  if (lo == null || (b && hi == null)) return null;

  // ── pay period → annual. After the figure first, then the NEAREST period word before ──
  let period: SalaryPeriod | null = null;
  const after = text.slice(end, end + 40);
  for (const [re, p] of PERIOD_AFTER) if (!period && re.test(after)) period = p;
  // a period written on the first end of a range ("$50/hr – $70/hr")
  if (!period && b) for (const [re, p] of PERIOD_AFTER) if (!period && re.test(text.slice(a.end, b.start))) period = p;
  if (!period) period = nearestPeriodBefore(text.slice(Math.max(0, start - 40), start));
  if (scales.includes("lpa")) period = "year";
  let inferred = false;
  const ann = (p: SalaryPeriod | null) => ({ lo: lo! * PERIOD_FACTOR[p ?? "year"], hi: hi != null ? hi * PERIOD_FACTOR[p ?? "year"] : null });
  let v = ann(period);
  if (period == null && !plausible(v.lo, v.hi, currency, false)) {
    // "€4,500 – €5,500 brutto", "₹50,000 – ₹70,000": too small to be a year's pay, a
    // plausible month's — read as monthly, and say we inferred it (never high)
    const m = ann("month");
    if (plausible(m.lo, m.hi, currency, true)) {
      period = "month";
      inferred = true;
      v = m;
    }
  }
  lo = v.lo;
  hi = v.hi;
  if (!plausible(lo, hi, currency, period != null && period !== "year")) return null;
  if (hi != null && (hi < lo || hi / lo > 5)) return null;

  // ── is this pay? a pay word near it; a company metric just before it and no pay word
  //    alongside ("raised $500k", "TPV of INR …") means it isn't ──
  const near = text.slice(Math.max(0, start - 60), start);
  if (NOT_PAY.test(near) && !PAY_WORD.test(near)) return null;
  const kwNear =
    structured ||
    PAY_WORD.test(text.slice(Math.max(0, start - 160), start)) ||
    PAY_WORD.test(text.slice(end, end + 40)) ||
    scales.includes("lpa");

  // ── shape ──
  let kind: Kind = hi != null ? "range" : "point";
  if (!b) {
    const lead = text.slice(Math.max(0, start - 20), start);
    if (CAP_BEFORE.test(lead)) kind = "cap";
    else if (FLOOR_BEFORE.test(lead) || /^\s*\+(?!\s*(?:equity|stock|benefits|bonus))/i.test(text.slice(end))) kind = "floor";
  }

  // ── what the figure covers, and equity on top ──
  // the nearest basis word before the figure ("Base salary $140k–160k; OTE $280k–320k" gives
  // each band its own), else one written right after it ("$180k OTE")
  const basis = nearestBefore(BASIS, text.slice(Math.max(0, start - 60), start)) ?? firstAfter(BASIS, text.slice(end, end + 16));
  const equity = EQUITY_AFTER.test(text.slice(end, end + 80));

  // ── confidence (see header) ──
  const annualish = period == null || period === "year" || period === "month";
  // an undated INR band below a full-time annual wage is as likely MONTHLY ("₹2L – ₹2.5L" for
  // a senior backend role, 4+ yrs — audit 2026-11): it can't be the high band a hard floor acts on
  const periodUnclear = (period == null && currency === "INR" && Math.max(lo, hi ?? 0) < INR_ANNUAL_MIN) || inferred;
  let confidence: SalaryConfidence;
  if (!explicit) confidence = "medium";
  else if (!ambiguous && !periodUnclear && kwNear && annualish && (kind === "range" || kind === "cap")) confidence = "high";
  else if (kwNear || kind === "range") confidence = "medium_high";
  else return null; // a lone currency figure in prose with no pay word: too weak to state

  const base = { currency, confidence, kind, period: period ?? "year", basis, equity } as const;
  switch (kind) {
    case "range":
      return { ...base, min: lo, max: hi };
    case "cap":
      return { ...base, min: null, max: lo };
    default:
      // a single figure / "from X": a soft floor — it says nothing about the ceiling
      return { ...base, min: lo, max: null };
  }
}

function nearestPeriodBefore(before: string): SalaryPeriod | null {
  return nearestBefore(PERIOD_BEFORE, before);
}

/** the label whose (global) pattern matches LAST in `before` — the word closest to the figure */
function nearestBefore<T>(table: Array<[RegExp, T]>, before: string): T | null {
  let best: { at: number; v: T } | null = null;
  for (const [re, v] of table) {
    for (const m of before.matchAll(re)) if (!best || m.index! > best.at) best = { at: m.index!, v };
  }
  return best?.v ?? null;
}

function firstAfter<T>(table: Array<[RegExp, T]>, after: string): T | null {
  let best: { at: number; v: T } | null = null;
  for (const [re, v] of table) {
    for (const m of after.matchAll(re)) if (!best || m.index! < best.at) best = { at: m.index!, v };
  }
  return best?.v ?? null;
}

/** Apply the written scale; a bare INR figure < 1000 in a salary FIELD means lakhs ("20-30"). */
function scaleValue(raw: number, scale: string | null, currency: string, structured: boolean): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (scale) return raw * (SCALE[scale] ?? 1);
  if (currency === "INR" && raw < 1000) return structured ? raw * 1e5 : null;
  return raw;
}

function plausible(lo: number, hi: number | null, currency: string, periodStated: boolean): boolean {
  return plausibleAnnual(lo, currency, periodStated) && (hi == null || plausibleAnnual(hi, currency, periodStated));
}

/**
 * Reject parses that can't be a year's pay (a "2024", a "401k", a "$50M" raise). A figure
 * with a stated sub-annual period may be lower (an intern's ₹5,000/month stipend).
 */
function plausibleAnnual(n: number, currency: string, periodStated: boolean): boolean {
  if (currency === "INR") return n >= (periodStated ? 50_000 : 100_000) && n <= 100_000_000; // ₹0.5–1 L … ₹10 Cr
  const usd = toUsd(n, currency);
  return usd != null && usd >= (periodStated ? 5_000 : 10_000) && usd <= 1_000_000;
}

/**
 * A pay amount someone TYPED — a salary floor, `--min-salary`, a filter box: "40L INR",
 * "$120k", "5000 EUR/mo", "₹30 LPA", "60k GBP per year", "150000" (+ `defaultCurrency`).
 * Same number/currency/period grammar as postings; returns the ANNUAL amount and how it was
 * written. A typed "$" is USD (the user means their own dollar when they write "CA$").
 */
export function parseMoneyInput(
  input: string | number,
  defaultCurrency?: string | null,
): { amount: number; currency: string; period: SalaryPeriod } | null {
  const fallback = (defaultCurrency || "USD").toUpperCase();
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? { amount: input, currency: fallback, period: "year" } : null;
  const text = toPlainText(input).trim();
  if (!text) return null;
  const [t] = scanAmounts(text);
  if (!t) return null;
  let currency: string | null = null;
  for (const m of t.marks) {
    if (m === "$") currency ??= "USD";
    else if (m === "kr") currency ??= ["SEK", "NOK", "DKK", "ISK"].includes(fallback) ? fallback : "SEK";
    else if (m === "¥") currency ??= fallback === "CNY" ? "CNY" : "JPY";
    else currency = m;
  }
  // a code written apart from the number ("150k  usd", "5000/mo EUR")
  if (!currency) {
    const code = text.slice(t.end).match(/\b([A-Za-z]{3})\b/);
    const c = code ? CUR_OF.get(code[1]!.toUpperCase()) : undefined;
    if (c && !["$", "kr", "¥"].includes(c)) currency = c;
  }
  if (!currency && t.scale && INR_SCALES.has(t.scale)) currency = "INR";
  currency ??= fallback;
  const value = t.raw * (t.scale ? SCALE[t.scale] ?? 1 : 1);
  if (!(value > 0)) return null;
  let period: SalaryPeriod = "year";
  const rest = text.slice(t.end);
  for (const [re, p] of PERIOD_AFTER) {
    if (re.test(rest)) {
      period = p;
      break;
    }
  }
  if (t.scale === "lpa") period = "year";
  return { amount: value * PERIOD_FACTOR[period], currency, period };
}

/**
 * Boards store the JD as HTML: Greenhouse's pay block is
 * `<span>$164,000</span><span class="divider">&mdash;</span><span>$323,000 USD</span>`, and
 * the tags between the two ends would split one range into two lone figures.
 */
function toPlainText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;|\u00a0|\u202f/gi, " ")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "—")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/&yen;|&#165;/gi, "¥")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}
