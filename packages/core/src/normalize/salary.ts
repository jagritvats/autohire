import type { SalaryBand } from "../schema/entities.js";
import type { SalaryConfidence } from "../schema/enums.js";
import { toUsd } from "../salary/fx.js";

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
 *                source's own salary field) · annual or monthly pay
 *   medium_high  explicit currency, but a single figure, no pay word, an annualised hourly/
 *                daily rate, or a bare "$" the location says may not be USD
 *   medium       the source's salary field with no currency, priced in the location's
 */

export interface SalaryParseOptions {
  /** the text is the source's own salary field (ATS/aggregator pay string), not JD prose */
  structured?: boolean;
  /** currency the posting's location implies (`currencyHintFor`) */
  currencyHint?: string | null;
}

type Period = "year" | "month" | "week" | "day" | "hour";
type Kind = "range" | "cap" | "floor" | "point";

interface Token {
  start: number;
  end: number;
  raw: number;
  scale: string | null;
  /** currencies written on the token, pre then post (e.g. "$", "CAD") */
  marks: string[];
}

interface Candidate {
  min: number | null;
  max: number | null;
  currency: string;
  confidence: SalaryConfidence;
  kind: Kind;
}

// Written before an amount. Qualified dollars first so "CA$" never reads as "$".
const PRE: Array<[string, string]> = [
  ["US$", "USD"], ["USD", "USD"], ["CA$", "CAD"], ["C$", "CAD"], ["CAD", "CAD"],
  ["AU$", "AUD"], ["A$", "AUD"], ["AUD", "AUD"], ["NZ$", "NZD"], ["NZD", "NZD"],
  ["S$", "SGD"], ["SGD", "SGD"], ["HK$", "HKD"], ["HKD", "HKD"], ["R$", "BRL"], ["BRL", "BRL"],
  ["INR", "INR"], ["Rs.", "INR"], ["Rs", "INR"], ["₹", "INR"],
  ["EUR", "EUR"], ["€", "EUR"], ["GBP", "GBP"], ["£", "GBP"], ["CHF", "CHF"],
  ["SEK", "SEK"], ["NOK", "NOK"], ["DKK", "DKK"], ["PLN", "PLN"],
  ["JPY", "JPY"], ["¥", "JPY"], ["KRW", "KRW"], ["₩", "KRW"], ["ILS", "ILS"], ["₪", "ILS"],
  ["$", "$"], // bare dollar: USD unless the location says otherwise (resolved per candidate)
];
// Written after an amount ("150,000 USD", "60.000 €").
const POST: Array<[string, string]> = [
  ["USD", "USD"], ["CAD", "CAD"], ["AUD", "AUD"], ["SGD", "SGD"], ["NZD", "NZD"], ["HKD", "HKD"],
  ["INR", "INR"], ["EUR", "EUR"], ["€", "EUR"], ["GBP", "GBP"], ["£", "GBP"], ["CHF", "CHF"],
  ["SEK", "SEK"], ["NOK", "NOK"], ["DKK", "DKK"], ["PLN", "PLN"], ["JPY", "JPY"], ["KRW", "KRW"],
  ["ILS", "ILS"], ["BRL", "BRL"], ["₹", "INR"],
];
const CUR_OF = new Map<string, string>([...PRE, ...POST].map(([t, c]) => [t.toUpperCase(), c]));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One money-ish amount: [currency] number [scale] [currency]. Number forms: Western/Indian
 * comma grouping (150,000 · 12,00,000), European dot grouping (60.000), Swiss (120'000),
 * plain/decimal (28, 1.2). Never glued to a word or another number.
 */
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])` +
    `(?:(${PRE.map(([t]) => esc(t)).join("|")})\\s?)?` +
    String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?![\d,])|\d{1,3}(?:['’]\d{3})+|\d+(?:\.\d+)?)` +
    String.raw`(?:\s?(k|million|mn?|billion|bn?|lpa|lakhs?|lacs?|l|crores?|cr)(?!\p{L}))?` +
    `(?:\\s?(${POST.map(([t]) => esc(t)).join("|")})(?!\\p{L}))?`,
  "giu",
);

const SCALE: Record<string, number> = {
  k: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
  lpa: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7,
};
const INR_SCALES = new Set(["lpa", "lakh", "lakhs", "lac", "lacs", "l", "crore", "crores", "cr"]);

/** "150 lakh crore", "5 million users"-style compound magnitudes are never pay. */
const COMPOUND_AFTER = /^\s*(?:crores?|cr|lakhs?|lacs?|million|billion|bn|mn|trillion)(?!\p{L})/iu;
const RANGE_SEP = /^\s*(?:-|–|—|~|to|and|until)\s*$/i;

/** Words that make a nearby figure a salary. */
const PAY_WORD = /\b(salary|salaries|compensation|pay|pays|paid|ctc|stipend|remuneration|wages?|ote|earnings?|per annum|annual base|base (?:salary|pay|compensation)|pay (?:range|band|scale)|hiring range|package|lpa)\b/i;
/** Words that make a nearby figure a company metric or a one-off, not pay. */
const NOT_PAY = /\b(raised|raising|funding|funded|valuation|valued|revenue|arr|gmv|tpv|turnover|market cap\w*|series [a-f]|seed|invest\w*|customers?|users|merchants|transactions?|volume|donat\w*|prize|award)\b/i;
/** The amount directly modifies a perk / one-off ("$15,000 signing bonus", "$1,000 learning budget"). */
const PERK_AFTER = /^\s*(?:(?:annual|yearly|one[- ]time|signing|sign[- ]on|joining|referral|relocation|learning|education|wellness|home[- ]office|wfh|internet|phone|equipment|travel|meal|health)\s+)?(?:bonus|budget|allowance|reimbursement|credits?|grant|fund)\b|^\s*(?:learning|education|wellness|home[- ]office|wfh|internet|phone|equipment)\s+stipend\b/i;

const CAP_BEFORE = /\b(?:up ?to|max(?:imum)?|as high as|not more than|no more than)\s*$/i;
const FLOOR_BEFORE = /\b(?:from|starting (?:at|from)|min(?:imum)?|at least|over|above|more than)\s*$/i;

const PERIOD_AFTER: Array<[RegExp, Period]> = [
  [/^\s*(?:\/|per|an?|each)\s*(?:hr|hour)\b|^\s*(?:hourly|p\/?h)\b/i, "hour"],
  [/^\s*(?:\/|per|a)\s*day\b|^\s*daily\b/i, "day"],
  [/^\s*(?:\/|per|a)\s*(?:wk|week)\b|^\s*weekly\b/i, "week"],
  [/^\s*(?:\/|per|a)\s*(?:mo|mth|month)\b|^\s*(?:monthly|p\.?m\.?)(?![a-z])/i, "month"],
  [/^\s*(?:\/|per|a)\s*(?:yr|year|annum)\b|^\s*(?:annually|yearly|p\.?\s?a\.?)(?![a-z])/i, "year"],
];
const PERIOD_BEFORE: Array<[RegExp, Period]> = [
  [/\bhourly\b|\bper hour\b/i, "hour"],
  [/\bmonthly\b|\bper month\b/i, "month"],
  [/\bannual\b|\bper annum\b|\byearly\b/i, "year"],
];
const ANNUALISE: Record<Period, number> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

/** dollar currencies a bare "$" may actually mean, per the posting's location */
const DOLLARS = new Set(["USD", "CAD", "AUD", "SGD", "NZD", "HKD"]);

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
  const top = candidates.filter((c) => rank(c) === best);
  const first = top[0]!;
  const same = top.filter((c) => c.currency === first.currency);
  const mins = same.map((c) => c.min).filter((n): n is number => n != null);
  const maxs = same.map((c) => c.max).filter((n): n is number => n != null);
  let min = mins.length ? Math.min(...mins) : null;
  let max = maxs.length ? Math.max(...maxs) : null;
  if (min != null && max != null && max / min > 5) {
    // too far apart to be one role's tiers — trust the first band alone
    min = first.min;
    max = first.max;
  }
  return { min, max, currency: first.currency, source: "jd_direct", confidence: first.confidence };
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
  return Number(s.replace(/[,'’]/g, ""));
}

function buildCandidate(text: string, a: Token, b: Token | null, opts: SalaryParseOptions): Candidate | null {
  const structured = !!opts.structured;
  const start = a.start;
  const end = (b ?? a).end;
  if (COMPOUND_AFTER.test(text.slice(end)) || (b && COMPOUND_AFTER.test(text.slice(a.end)))) return null;
  if (PERK_AFTER.test(text.slice(end, end + 40))) return null;

  // ── currency: a code / qualified dollar on either end beats a bare "$"; an Indian unit
  //    (LPA, lakh, crore) is itself a currency mark ──
  const marks = [...a.marks, ...(b?.marks ?? [])];
  const scales = [a.scale, b?.scale].filter((s): s is string => !!s);
  let currency: string | null = marks.find((c) => c !== "$") ?? (marks.includes("$") ? "$" : null);
  if (!currency && scales.some((s) => INR_SCALES.has(s))) currency = "INR";
  let explicit = currency != null;
  let ambiguous = false;
  if (currency === "$") {
    const hint = opts.currencyHint?.toUpperCase();
    ambiguous = !!hint && hint !== "USD" && DOLLARS.has(hint);
    currency = ambiguous ? hint! : "USD";
  }
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

  // ── pay period → annual ──
  let period: Period | null = null;
  const after = text.slice(end, end + 30);
  const before = text.slice(Math.max(0, start - 40), start);
  for (const [re, p] of PERIOD_AFTER) if (!period && re.test(after)) period = p;
  for (const [re, p] of PERIOD_BEFORE) if (!period && re.test(before)) period = p;
  if (scales.includes("lpa")) period = "year";
  lo *= ANNUALISE[period ?? "year"];
  if (hi != null) hi *= ANNUALISE[period ?? "year"];
  if (!plausibleAnnual(lo, currency) || (hi != null && !plausibleAnnual(hi, currency))) return null;
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
    else if (FLOOR_BEFORE.test(lead) || /^\s*\+/.test(text.slice(end))) kind = "floor";
  }

  // ── confidence (see header) ──
  const annualish = period == null || period === "year" || period === "month";
  let confidence: SalaryConfidence;
  if (!explicit) confidence = "medium";
  else if (!ambiguous && kwNear && annualish && (kind === "range" || kind === "cap")) confidence = "high";
  else if (kwNear || kind === "range") confidence = "medium_high";
  else return null; // a lone currency figure in prose with no pay word: too weak to state

  switch (kind) {
    case "range":
      return { min: lo, max: hi, currency, confidence, kind };
    case "cap":
      return { min: null, max: lo, currency, confidence, kind };
    default:
      // a single figure / "from X": a soft floor — it says nothing about the ceiling
      return { min: lo, max: null, currency, confidence, kind };
  }
}

/** Apply the written scale; a bare INR figure < 1000 in a salary FIELD means lakhs ("20-30"). */
function scaleValue(raw: number, scale: string | null, currency: string, structured: boolean): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (scale) return raw * (SCALE[scale] ?? 1);
  if (currency === "INR" && raw < 1000) return structured ? raw * 1e5 : null;
  return raw;
}

/** Reject parses that can't be a year's pay (a "2024", a "401k", a "$50M" raise). */
function plausibleAnnual(n: number, currency: string): boolean {
  if (currency === "INR") return n >= 100_000 && n <= 100_000_000; // ₹1 L … ₹10 Cr
  const usd = toUsd(n, currency);
  return usd != null && usd >= 10_000 && usd <= 1_000_000;
}

/**
 * Boards store the JD as HTML: Greenhouse's pay block is
 * `<span>$164,000</span><span class="divider">&mdash;</span><span>$323,000 USD</span>`, and
 * the tags between the two ends would split one range into two lone figures.
 */
function toPlainText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;| /gi, " ")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "—")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&pound;|&#163;/gi, "£")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}
