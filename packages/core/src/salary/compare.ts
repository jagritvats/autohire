import type { Posting, SalaryBand } from "../schema/entities.js";
import type { SalaryConfidence } from "../schema/enums.js";
import { convertWithInfo, type FxTable } from "./fx.js";
import { isAnnualisedRate } from "./period.js";

/**
 * Pay comparisons in ONE currency (§11.4) — the salary floor, the min-salary view filter,
 * sort-by-pay and the salary score all go through here, so a ₹ posting and a $ floor are
 * compared on the same footing: annual figures, converted at a dated FX rate.
 *
 * A converted figure is less certain than a stated one. Two rules keep that honest:
 *  - soft uses (score, sort) take the band's confidence one step DOWN when converted;
 *  - hard decisions (the floor's exclusion, a view hiding a posting) only fire when the
 *    figure stays below the line after allowing for the rate's full uncertainty
 *    (`fxUncertainty`: 3% + 1% per month of rate age, ≤ 15%) — so a shaky conversion never
 *    excludes a posting (invariant #4).
 */

const DOWN: Record<SalaryConfidence, SalaryConfidence> = { high: "medium_high", medium_high: "medium", medium: "low", low: "low" };

export interface ComparablePay {
  /** annual, in the target currency */
  min: number | null;
  max: number | null;
  currency: string;
  /** the band's confidence, one step down when converted */
  confidence: SalaryConfidence;
  converted: boolean;
  rateDate: string | null;
  uncertainty: number;
}

export interface CompareOptions {
  fx?: FxTable;
  now?: Date;
}

export function hasStated(band: Pick<SalaryBand, "source" | "min" | "max">): boolean {
  return band.source !== "none" && (band.min != null || band.max != null);
}

/** A stated band as annual figures in `currency`; null when unstated or no rate is known. */
export function comparablePay(band: SalaryBand, currency: string, opts: CompareOptions = {}): ComparablePay | null {
  if (!hasStated(band)) return null;
  const lo = band.min != null ? convertWithInfo(band.min, band.currency, currency, opts) : null;
  const hi = band.max != null ? convertWithInfo(band.max, band.currency, currency, opts) : null;
  if ((band.min != null && !lo) || (band.max != null && !hi)) return null;
  const info = (hi ?? lo)!;
  return {
    min: lo?.amount ?? null,
    max: hi?.amount ?? null,
    currency: info.currency,
    confidence: info.converted ? DOWN[band.confidence] : band.confidence,
    converted: info.converted,
    rateDate: info.rateDate,
    uncertainty: info.uncertainty,
  };
}

/**
 * Is a STATED, HIGH-confidence ceiling clearly below `ratio × floor`? The only salary fact
 * strong enough to hide or exclude a posting:
 *  - stated, `high` (currency + range/cap + a pay word or the source's salary field);
 *  - a ceiling — "from ₹X" says nothing about the top;
 *  - an annual or monthly figure — an hourly/daily/weekly rate is annualised on an
 *    assumption about hours, so it never decides alone;
 *  - converted, it must stay below the line after adding the rate's uncertainty.
 */
export function statedCeilingBelow(
  band: SalaryBand,
  floor: number,
  floorCurrency: string,
  ratio = 1,
  opts: CompareOptions = {},
): { below: boolean; top: number | null; converted: boolean; rateDate: string | null } {
  const no = { below: false, top: null, converted: false, rateDate: null };
  if (!(floor > 0) || !hasStated(band) || band.max == null || band.confidence !== "high") return no;
  if (isAnnualisedRate(band.period)) return no;
  const c = convertWithInfo(band.max, band.currency, floorCurrency, opts);
  if (!c) return no; // an unknown currency is never compared by guesswork
  return { below: c.amount * (1 + c.uncertainty) < floor * ratio, top: c.amount, converted: c.converted, rateDate: c.rateDate };
}

/**
 * A posting's pay for "sort by pay", annual in `currency`: the stated top (else its floor),
 * else the estimate's median. null sorts last. Estimates and converted figures rank as
 * figures — sorting is a view, not a judgement — and the card says which they are.
 */
export function payForSort(p: Pick<Posting, "salary" | "salaryEstimate">, currency: string, opts: CompareOptions = {}): number | null {
  const c = comparablePay(p.salary, currency, opts);
  if (c) return c.max ?? c.min;
  const e = p.salaryEstimate;
  if (e) return convertWithInfo(e.median, e.currency, currency, opts)?.amount ?? null;
  return null;
}
