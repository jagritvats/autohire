/**
 * What the top of Jobs says about your list today — one set of numbers that each style
 * presents its own way: Editorial as a one-sentence lede under a dated masthead, Spark as a
 * row of colourful count chips, Classic not at all (it keeps the plain counts). Plain counts
 * over live jobs (not hidden, not reported) by the SOURCE's own date; an unscored list never
 * claims a "strongest" or a "great match".
 */
export interface TodayCard {
  id: string;
  title: string;
  company: string;
  score: number;
  ageDays: number;
  archived?: boolean;
  invalidated?: boolean;
}

export interface TodaySummary {
  /** live jobs considered */
  live: number;
  /** posted within the last day */
  fresh: number;
  /** posted within the last week */
  newThisWeek: number;
  /** strong matches (score ≥ 78); 0 when unscored */
  great: number;
  /** the strongest live match; null when unscored or empty */
  top: TodayCard | null;
}

export function todaySummary<C extends TodayCard>(cards: C[], scored: boolean): TodaySummary & { top: C | null } {
  const live = cards.filter((c) => !c.archived && !c.invalidated);
  return {
    live: live.length,
    fresh: live.filter((c) => c.ageDays <= 1).length,
    newThisWeek: live.filter((c) => c.ageDays <= 7).length,
    great: scored ? live.filter((c) => c.score >= 78).length : 0,
    top: scored && live.length ? live.reduce((a, b) => (b.score > a.score ? b : a)) : null,
  };
}
