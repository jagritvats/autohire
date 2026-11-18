import type { PayDisplay, Posting, ProfilePrefs } from "../schema/entities.js";
import type { SalaryBasis, SalaryPeriod } from "../schema/enums.js";
import { effectiveHomeCountry } from "../match/region.js";
import { countryDisplayName, locationCountryCodes } from "../normalize/location.js";
import { convertWithInfo, currencyForCountry, currencySymbol, knownCurrency, type FxTable } from "./fx.js";
import { PERIOD_FACTOR, PERIOD_SHORT, PERIOD_WORD, isAnnualisedRate } from "./period.js";

/**
 * THE pay formatter (§11.4) — web cards, the job page, filters, CLI feed/show and MCP card
 * text all print pay through this, so a figure reads the same everywhere:
 *
 *   ₹30L–45L / yr (≈ $36k–54k)             stated annual INR, shown to a USD reader
 *   €5,500–6,500 / mo (≈ €66k–78k / yr)    stated monthly, same currency, yearly view
 *   $50–70 / hr (≈ $104k–146k / yr, annualised from hourly)
 *   est. $150k–190k / yr                    a model's estimate, never passed off as stated
 *
 * The posting's own currency and period always lead (what it SAYS); the "≈" part is the
 * reader's display currency and period, converted at a dated rate (`rateDate`). Pure.
 */

export interface PayLike {
  /** ANNUAL figures, as stored on `posting.salary` / `posting.salaryEstimate` */
  min: number | null;
  max: number | null;
  currency: string;
  /** the period the posting stated (absent = year) */
  period?: SalaryPeriod | null;
  basis?: SalaryBasis | null;
  equity?: boolean | null;
  /** an estimate's median (the rough figure); else the band's geometric midpoint */
  median?: number | null;
}

export interface FormatPayOptions {
  /** resolved display currency (ISO code) — null/undefined = no converted figure */
  currency?: string | null;
  /** the period the "≈" figure is shown per (default year) */
  period?: "year" | "month";
  /** a model's estimate: prefixed "est." */
  estimate?: boolean;
  /** a LOW-confidence estimate: one rounded midpoint, "rough est. ~₹19L / yr" */
  rough?: boolean;
  fx?: FxTable;
  now?: Date;
}

export interface FormattedPay {
  /** the whole line: primary + (≈ converted, note) */
  text: string;
  /** in the posting's own currency and period: "₹30L–45L / yr" */
  primary: string;
  /** "≈ $36k–54k" (null when nothing to convert or re-period) */
  converted: string | null;
  /** "annualised from hourly" when an hourly/daily/weekly rate was turned into a year */
  note: string | null;
  /** date of the FX rate used, when a currency was converted */
  rateDate: string | null;
}

export function formatPay(input: PayLike, opts: FormatPayOptions = {}): FormattedPay | null {
  if (input.min == null && input.max == null) return null;
  let pay = input;
  if (opts.rough) {
    // one rounded midpoint — a weak guess must not look like a precise band
    const mid = roundSig(input.median ?? (input.min != null && input.max != null ? Math.sqrt(input.min * input.max) : (input.min ?? input.max)!), 2);
    pay = { ...input, min: mid, max: mid };
  }
  const cur = pay.currency.toUpperCase();
  const stated: SalaryPeriod = pay.period ?? "year";
  const f = PERIOD_FACTOR[stated];

  const tags = [pay.basis === "ote" ? "OTE" : pay.basis === "total" ? "total comp" : null, pay.equity ? "+ equity" : null]
    .filter(Boolean)
    .join(" ");
  const primary =
    `${opts.rough ? "rough est. ~" : opts.estimate ? "est. " : ""}${shape(pay.min != null ? pay.min / f : null, pay.max != null ? pay.max / f : null, cur, stated)} / ${PERIOD_SHORT[stated]}` +
    (tags ? ` ${tags}` : "");

  // ── the "≈" part: display currency × display period ──
  const want = opts.currency && knownCurrency(opts.currency, opts.fx) ? opts.currency.toUpperCase() : null;
  const viewPeriod: SalaryPeriod = opts.period ?? "year";
  const annualised = isAnnualisedRate(stated);
  const target = want ?? cur;
  const reCurrency = want != null && want !== cur;
  // an hourly/daily/weekly rate always gets its yearly equivalent (that's what's compared)
  const rePeriod = viewPeriod !== stated || annualised;
  let converted: string | null = null;
  let rateDate: string | null = null;
  const outPeriod: SalaryPeriod = annualised && viewPeriod === stated ? "year" : viewPeriod;
  if (reCurrency || rePeriod) {
    const conv = (n: number | null) => (n == null ? null : convertWithInfo(n, cur, target, { fx: opts.fx, now: opts.now }));
    const lo = conv(pay.min);
    const hi = conv(pay.max);
    if ((pay.min == null || lo) && (pay.max == null || hi)) {
      const g = PERIOD_FACTOR[outPeriod];
      const body = shape(lo ? lo.amount / g : null, hi ? hi.amount / g : null, target, outPeriod, true);
      converted = `≈ ${body}${outPeriod !== stated ? ` / ${PERIOD_SHORT[outPeriod]}` : ""}`;
      rateDate = (lo ?? hi)?.rateDate ?? null;
    }
  }
  const note = annualised ? `annualised from ${PERIOD_WORD[stated]}` : null;
  const extra = [converted, note].filter(Boolean).join(", ");
  return { text: extra ? `${primary} (${extra})` : primary, primary, converted, note, rateDate };
}

/**
 * One typed amount (a floor, a min-salary filter) as the formatter writes pay: "₹40L / yr",
 * "€5,000 / mo". `annual` is the stored annual figure; `period` how it was written.
 */
export function formatAmount(annual: number, currency: string, period: SalaryPeriod = "year"): string {
  return formatPay({ min: annual, max: annual, currency, period })!.primary;
}

/**
 * The display currency a reader asked for: an ISO code, "none" (original only → null), or
 * "auto" (default) = the home country's currency, else the salary-floor currency.
 */
export function resolveDisplayCurrency(
  prefs: Partial<Pick<ProfilePrefs, "homeCountry" | "markets" | "currency" | "locationWeights">> & { display?: Partial<PayDisplay> | null },
): string | null {
  const want = (prefs.display?.currency ?? "auto").trim().toUpperCase();
  if (want === "NONE" || want === "ORIGINAL") return null;
  if (want && want !== "AUTO") return knownCurrency(want) ? want : null;
  const home = effectiveHomeCountry({
    homeCountry: prefs.homeCountry ?? "",
    markets: prefs.markets ?? [],
    currency: prefs.currency ?? "",
    locationWeights: prefs.locationWeights ?? [],
  });
  return currencyForCountry(home) ?? (prefs.currency && knownCurrency(prefs.currency) ? prefs.currency.toUpperCase() : null);
}

/** Display options for a reader's prefs, ready for `formatPay`. */
export function payDisplayOptions(
  prefs: Parameters<typeof resolveDisplayCurrency>[0] | null | undefined,
): Pick<FormatPayOptions, "currency" | "period"> {
  if (!prefs) return {};
  return { currency: resolveDisplayCurrency(prefs), period: prefs.display?.period ?? "year" };
}

// ── a posting's pay, ready for a card ──

/**
 * An estimate below this confidence (or wider than ×`ROUGH_SPREAD` top ÷ bottom) is shown as
 * ONE rounded figure, "rough est. ~₹19L / yr" — never as a precise-looking band. Feed review
 * 2026-11: 45 of the India persona's top 50 cards showed "~₹10.9L–₹27.4L est 33%".
 */
export const ROUGH_ESTIMATE_BELOW = 0.4;
export const ROUGH_SPREAD = 2.2;

export interface PayView {
  /** the formatted line (formatPay) */
  label: string;
  /** what the posting states (false) or our model's estimate (true) */
  estimate: boolean;
  /** a low-confidence estimate collapsed to one rough figure */
  rough: boolean;
  /** stated: the parse confidence; estimate: its bucket */
  confidence: string;
  /** 0..1, estimates only */
  confidenceScore: number | null;
  source: string;
  /** estimates only: what it rests on */
  basis: string | null;
  /** "annualised from hourly" */
  note: string | null;
  /** the stated currency disagrees with where the role is ("₹ for a US-only role") */
  warning: string | null;
  /** FX rate date when a figure was converted */
  rateDate: string | null;
}

type PostingPay = Pick<Posting, "salary" | "salaryEstimate" | "location">;

/** Stated pay, else the estimate — formatted for one reader. null = neither. */
export function describePay(p: PostingPay, opts: Pick<FormatPayOptions, "currency" | "period" | "fx" | "now"> = {}): PayView | null {
  const s = p.salary;
  if (s.source !== "none" && (s.min != null || s.max != null)) {
    const f = formatPay(s, opts)!;
    return {
      label: f.text, estimate: false, rough: false, confidence: s.confidence, confidenceScore: null, source: s.source,
      basis: null, note: f.note, warning: currencyMismatch(p), rateDate: f.rateDate,
    };
  }
  const e = p.salaryEstimate;
  if (!e) return null;
  const rough = e.confidenceScore < ROUGH_ESTIMATE_BELOW || (e.min > 0 && e.max / e.min > ROUGH_SPREAD);
  const f = formatPay({ min: e.min, max: e.max, median: e.median, currency: e.currency }, { ...opts, estimate: true, rough })!;
  return {
    label: f.text, estimate: true, rough, confidence: e.confidence, confidenceScore: e.confidenceScore,
    source: e.sources.map((x) => x.source).join(" + "), basis: e.basis, note: null, warning: null, rateDate: f.rateDate,
  };
}

/**
 * Does the STATED currency disagree with where the role is? A ₹ band on a US-only remote role
 * ("Golang Developer · Remote · US only · ₹6L–₹15L") is kept — it's what the posting says —
 * but flagged. USD is paid across borders, so a $ band anywhere is not a disagreement; nor is
 * anything on a role with no known place.
 */
export function currencyMismatch(p: Pick<Posting, "salary" | "location">): string | null {
  const s = p.salary;
  if (s.source === "none" || (s.min == null && s.max == null)) return null;
  const cur = s.currency.toUpperCase();
  if (cur === "USD") return null;
  const codes = locationCountryCodes(p.location);
  const geo = p.location.mode === "remote" ? REMOTE_GEO_COUNTRY[p.location.remoteGeo] : undefined;
  if (geo) codes.push(geo);
  const expected = new Set(codes.map((c) => currencyForCountry(c)).filter((c): c is string => !!c));
  if (!expected.size || expected.has(cur)) return null;
  const where = p.location.mode === "remote" && geo ? (geo === "US" ? "a US-only remote role" : `a remote role for ${countryDisplayName(geo)}`) : `a role in ${codes.map(countryDisplayName).slice(0, 2).join(" / ")}`;
  return `Pay is stated in ${cur} for ${where} — check the posting`;
}

const REMOTE_GEO_COUNTRY: Partial<Record<Posting["location"]["remoteGeo"], string>> = { us_only: "US", india_ok: "IN" };

function roundSig(n: number, digits: number): number {
  if (!(n > 0)) return n;
  const p = Math.pow(10, Math.floor(Math.log10(n)) - digits + 1);
  return Math.round(n / p) * p;
}

// ── amounts ──

/** "₹30L–45L", "$150k–200k", "€5,500–6,500", "up to $200k", "$140k+" */
function shape(lo: number | null, hi: number | null, cur: string, period: SalaryPeriod, approx = false): string {
  const sym = currencySymbol(cur);
  const a = (n: number) => amount(n, cur, period, approx);
  const withCur = (s: string) => (sym ? `${sym}${s}` : `${cur} ${s}`);
  if (lo != null && hi != null) {
    const x = a(lo);
    const y = a(hi);
    return x === y ? withCur(x) : withCur(`${x}–${y}`);
  }
  if (hi != null) return `up to ${withCur(a(hi))}`;
  return `${withCur(a(lo!))}+`;
}

/** one amount without its currency mark */
function amount(n: number, cur: string, period: SalaryPeriod, approx: boolean): string {
  if (cur === "INR") {
    if (n >= 10_000_000) return `${trim(n / 10_000_000, 2)}Cr`;
    if (n >= 100_000) return `${trim(n / 100_000, 2)}L`;
    return group(roundTo(n, approx ? 1000 : 1), "en-IN");
  }
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 2)}M`;
  // a year's pay reads in thousands; a month's / day's / hour's as written
  if (period === "year" || n >= 100_000 || (approx && n >= 10_000)) return `${trim(n / 1000, n < 10_000 ? 1 : 0)}k`;
  if (approx && n >= 1000) return `${trim(n / 1000, 1)}k`;
  if (period === "hour" && !Number.isInteger(Math.round(n * 100) / 100)) return group(Math.round(n * 100) / 100, "en-US", 2);
  return group(Math.round(n), "en-US");
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function group(n: number, locale: string, digits = 0): string {
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function trim(x: number, digits: number): string {
  return x.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
