/**
 * Currency conversion for salary comparison (§11.4). A static, dated table on purpose:
 * `core` stays pure (no network), and salary is a soft, banded signal (≥ floor / ≥ 0.8×
 * floor), so a few percent of FX drift can't move a posting across a band edge in any way
 * that matters. Refresh the table when rates move materially.
 *
 * Nominal rates, not PPP: the question is "what would this offer pay me", and a USD offer
 * pays USD wherever you sit. Cost-of-living is the location score's job, not this.
 *
 * Source: ECB reference rates via api.frankfurter.dev, units of currency per 1 USD.
 */
export const FX_AS_OF = "2026-09-25";
export const FX_PER_USD: Readonly<Record<string, number>> = {
  USD: 1,
  INR: 95.82,
  EUR: 0.87696,
  GBP: 0.75458,
  CAD: 1.4143,
  AUD: 1.4224,
  NZD: 1.7634,
  SGD: 1.2771,
  HKD: 7.844,
  CHF: 0.82829,
  SEK: 9.9009,
  NOK: 9.5063,
  DKK: 6.5557,
  PLN: 3.8339,
  JPY: 157.59,
  KRW: 1355.05,
  ILS: 3.0338,
  BRL: 5.1821,
};

/** Convert between currencies; null when either side is unknown (never guess a rate). */
export function convertCurrency(amount: number, from: string, to: string): number | null {
  if (from === to) return amount;
  const f = FX_PER_USD[from.toUpperCase()];
  const t = FX_PER_USD[to.toUpperCase()];
  if (f == null || t == null) return null;
  return (amount / f) * t;
}

export function toUsd(amount: number, currency: string): number | null {
  return convertCurrency(amount, currency, "USD");
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
};

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
