import type { SalaryPeriod } from "../schema/enums.js";

/**
 * Pay periods → a year (§11.4). Every comparison runs on ANNUAL figures; a posting's own
 * period is kept for display. The factors are full-time conventions, not facts about a
 * contract, which is why an hourly/daily/weekly figure is shown "annualised from hourly"
 * and is never the high-confidence band the hard floor acts on:
 *
 *   hour  × 2080   40 h × 52 weeks
 *   day   × 260    5 days × 52 weeks
 *   week  × 52
 *   month × 12     (a 13th-month salary is the posting's to state; we don't add one)
 *   year  × 1
 */
export const PERIOD_FACTOR: Readonly<Record<SalaryPeriod, number>> = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

/** an annual figure as the posting stated it (÷ its period's factor) */
export function fromAnnual(annual: number, period: SalaryPeriod | null | undefined): number {
  return annual / PERIOD_FACTOR[period ?? "year"];
}

export function toAnnual(amount: number, period: SalaryPeriod | null | undefined): number {
  return amount * PERIOD_FACTOR[period ?? "year"];
}

/** periods whose annual figure is an assumption about hours worked */
export function isAnnualisedRate(period: SalaryPeriod | null | undefined): boolean {
  return period === "hour" || period === "day" || period === "week";
}

export const PERIOD_SHORT: Readonly<Record<SalaryPeriod, string>> = { year: "yr", month: "mo", week: "wk", day: "day", hour: "hr" };
export const PERIOD_WORD: Readonly<Record<SalaryPeriod, string>> = { year: "yearly", month: "monthly", week: "weekly", day: "daily", hour: "hourly" };
