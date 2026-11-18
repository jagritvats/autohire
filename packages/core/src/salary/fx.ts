/**
 * Currency conversion for salary comparison and display (§11.4).
 *
 * A static, DATED table ships in core so nothing ever needs the network: `core` stays pure,
 * and every conversion can say which day's rate it used. The pipeline may refresh it from a
 * free, keyless public source (ECB reference rates via frankfurter — `pipeline/src/fx.ts`),
 * cache it in the store with its date, and install it with `installFxRates`; when that
 * source is unreachable nothing changes and the shipped table keeps working.
 *
 * Nominal rates, not PPP: the question is "what would this offer pay me", and a USD offer
 * pays USD wherever you sit. Cost-of-living is the location score's job, not this.
 *
 * A converted comparison is less sure than a same-currency one (the rate moves; nobody is
 * paid at the mid-market rate). `fxUncertainty` puts a number on that from the rate's age,
 * and `core/salary/compare.ts` widens every cross-currency hard decision by it, so the
 * salary floor never excludes a posting on a shaky conversion (invariant #4).
 */

/** Units of each currency per 1 USD, as of a date. */
export interface FxTable {
  /** the rates' own date (YYYY-MM-DD) — what "rate as of" shows */
  asOf: string;
  /** where they came from ("ECB via frankfurter", "static") */
  source: string;
  perUsd: Readonly<Record<string, number>>;
}

/**
 * Shipped table. Source: ECB euro foreign-exchange reference rates, rebased to USD, as
 * served by api.frankfurter.dev/v1/latest?base=USD on 2026-11-18. AED and SAR are not ECB
 * currencies; both are pegged to the USD (AED 3.6725, SAR 3.75 — UAE / Saudi central banks).
 * Any sync (and `pnpm --filter @jobflow/worker salary`) caches a newer table; edit this one when rates
 * move materially between releases.
 */
export const FX_AS_OF = "2026-11-18";
export const FX_PER_USD: Readonly<Record<string, number>> = {
  USD: 1,
  AUD: 1.4856,
  BRL: 5.8186,
  CAD: 1.4305,
  CHF: 0.84272,
  CNY: 6.6672,
  CZK: 22.234,
  DKK: 6.8147,
  EUR: 0.91174,
  GBP: 0.75939,
  HKD: 7.8467,
  HUF: 335.89,
  IDR: 18254,
  ILS: 3.2639,
  INR: 93.44,
  ISK: 124.91,
  JPY: 159.42,
  KRW: 1332.33,
  MXN: 18.5759,
  MYR: 4.116,
  NOK: 9.6686,
  NZD: 1.819,
  PHP: 63.669,
  PLN: 4.0224,
  RON: 4.8748,
  SEK: 10.1596,
  SGD: 1.2896,
  THB: 33.975,
  TRY: 50.438,
  ZAR: 17.2226,
  AED: 3.6725,
  SAR: 3.75,
};

export const STATIC_FX: FxTable = { asOf: FX_AS_OF, source: "ECB reference rates (shipped)", perUsd: FX_PER_USD };

/** pegged currencies the ECB doesn't publish — kept when a refreshed table lacks them */
const PEGGED: Readonly<Record<string, number>> = { AED: 3.6725, SAR: 3.75 };

let active: FxTable = STATIC_FX;

/**
 * Use a refreshed table for every later conversion in this process — only when it is NOT OLDER
 * than what's installed and sane (USD = 1, positive finite rates). Currencies it lacks keep
 * their shipped rate. Returns the table now in use.
 */
export function installFxRates(table: FxTable | null | undefined): FxTable {
  if (!table || !isValidFxTable(table) || table.asOf < active.asOf) return active;
  active = { asOf: table.asOf, source: table.source, perUsd: { ...FX_PER_USD, ...PEGGED, ...table.perUsd, USD: 1 } };
  return active;
}

/** back to the shipped table (tests) */
export function resetFxRates(): void {
  active = STATIC_FX;
}

export function activeFx(): FxTable {
  return active;
}

export function isValidFxTable(t: FxTable): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.asOf)) return false;
  const rates = Object.entries(t.perUsd);
  if (rates.length < 5) return false;
  return rates.every(([k, v]) => /^[A-Z]{3}$/.test(k) && Number.isFinite(v) && v > 0) && (t.perUsd.USD ?? 1) === 1;
}

export function knownCurrency(code: string, fx: FxTable = active): boolean {
  return fx.perUsd[code.toUpperCase()] != null;
}

/** Convert between currencies; null when either side is unknown (never guess a rate). */
export function convertCurrency(amount: number, from: string, to: string, fx: FxTable = active): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const rf = fx.perUsd[f];
  const rt = fx.perUsd[t];
  if (rf == null || rt == null) return null;
  return (amount / rf) * rt;
}

export function toUsd(amount: number, currency: string, fx: FxTable = active): number | null {
  return convertCurrency(amount, currency, "USD", fx);
}

/** A conversion and how far to trust it. */
export interface Converted {
  amount: number;
  currency: string;
  /** false when no conversion was needed (same currency) */
  converted: boolean;
  /** the rate's date, null when not converted */
  rateDate: string | null;
  /** ± relative error to allow for (0 when not converted) — see `fxUncertainty` */
  uncertainty: number;
}

export function convertWithInfo(
  amount: number,
  from: string,
  to: string,
  opts: { fx?: FxTable; now?: Date } = {},
): Converted | null {
  const fx = opts.fx ?? active;
  const v = convertCurrency(amount, from, to, fx);
  if (v == null) return null;
  const same = from.toUpperCase() === to.toUpperCase();
  return {
    amount: v,
    currency: to.toUpperCase(),
    converted: !same,
    rateDate: same ? null : fx.asOf,
    uncertainty: same ? 0 : fxUncertainty(fx, opts.now),
  };
}

/**
 * How wrong a converted figure may be, as a fraction: 3% for the mid-market vs a real
 * payroll rate, plus 1% per 30 days the rate has aged, capped at 15%. Major pairs rarely
 * move 5% in a quarter; a stale table must not pretend otherwise.
 */
export function fxUncertainty(fx: FxTable = active, now: Date = new Date()): number {
  const age = Math.max(0, (now.getTime() - Date.parse(`${fx.asOf}T00:00:00Z`)) / 86_400_000);
  return Math.min(0.15, 0.03 + 0.01 * (age / 30));
}

/**
 * The currency a country pays in (ISO-3166 alpha-2 → ISO-4217). Used for the default
 * display currency (your home country's) and to resolve a bare "$" / "kr" / "¥" from where
 * a posting is.
 */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  US: "USD", IN: "INR", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", GB: "GBP",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK", PL: "PLN", CZ: "CZK", HU: "HUF",
  RO: "RON", TR: "TRY", JP: "JPY", KR: "KRW", CN: "CNY", IL: "ILS", BR: "BRL", MX: "MXN",
  ZA: "ZAR", MY: "MYR", ID: "IDR", PH: "PHP", TH: "THB", AE: "AED", SA: "SAR",
  // euro area
  DE: "EUR", FR: "EUR", NL: "EUR", IE: "EUR", ES: "EUR", PT: "EUR", IT: "EUR", AT: "EUR",
  BE: "EUR", FI: "EUR", LU: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", SK: "EUR", SI: "EUR",
  HR: "EUR", GR: "EUR", CY: "EUR", MT: "EUR",
};

export function currencyForCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_CURRENCY[code.trim().toUpperCase()] ?? null;
}

const SYMBOL: Record<string, string> = {
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
  CAD: "CA$",
  AUD: "A$",
  SGD: "S$",
  NZD: "NZ$",
  HKD: "HK$",
  JPY: "¥",
  KRW: "₩",
  ILS: "₪",
  BRL: "R$",
  MXN: "MX$",
  PHP: "₱",
  TRY: "₺",
};

/** the symbol written before an amount ("$", "₹", "CA$"); null → write the ISO code */
export function currencySymbol(currency: string): string | null {
  return SYMBOL[currency.toUpperCase()] ?? null;
}

/** Compact annual pay: ₹18.5L / ₹1.2Cr (Indian units), $185k, €85k, CHF 120k. */
export function formatSalary(n: number, currency: string): string {
  if (currency === "INR") {
    return n >= 10_000_000 ? `₹${trim(n / 10_000_000, 2)}Cr` : `₹${trim(n / 100_000, 1)}L`;
  }
  const sym = SYMBOL[currency];
  const k = n >= 1_000_000 ? `${trim(n / 1_000_000, 2)}M` : `${Math.round(n / 1000)}k`;
  return sym ? `${sym}${k}` : `${currency} ${k}`;
}

function trim(x: number, digits: number): string {
  return x.toFixed(digits).replace(/\.?0+$/, "");
}
