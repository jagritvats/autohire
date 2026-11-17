import { countryCodeFromText, EUROPE_CODES, type LevelBand, type SearchQuery } from "@jobflow/core";
import type { FetchTarget, SearchTargetContext } from "./types.js";

/**
 * Shared, pure helpers for `SourceAdapter.toTargets` (saved / ad-hoc searches). A query
 * shapes WHAT a source is asked for; it never becomes a match filter (invariant #4).
 */

/** hard cap on targets one adapter emits for one query (politeness / cost). */
export const MAX_TARGETS_PER_QUERY = 3;

/** search phrases: titles first, then keywords, then must-have skills — deduped, ≤3. */
export function queryTerms(q: SearchQuery, max = MAX_TARGETS_PER_QUERY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...q.titles, ...q.keywords, ...(q.titles.length || q.keywords.length ? [] : q.mustSkills)]) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** ISO-2 countries the query is about: its locations (city → country when unambiguous), else the markets. */
export function queryCountries(q: SearchQuery, ctx: SearchTargetContext): string[] {
  const fromLocs = q.locations
    .map((l) => (l.country ?? countryCodeFromText(l.city) ?? "").trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const list = fromLocs.length ? fromLocs : ctx.markets.map((m) => m.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return [...new Set(list)];
}

/** the first city the query names in a country (or with no country), if any. */
export function queryCity(q: SearchQuery, country: string | null): string | null {
  for (const l of q.locations) {
    if (!l.city?.trim()) continue;
    const c = (l.country ?? countryCodeFromText(l.city) ?? "").toUpperCase();
    if (!country || !c || c === country) return l.city.trim();
  }
  return null;
}

/** India-only boards serve a query only when India is one of its countries. */
export function inIndia(q: SearchQuery, ctx: SearchTargetContext): boolean {
  return queryCountries(q, ctx).includes("IN");
}

export function isEuropean(code: string): boolean {
  return EUROPE_CODES.has(code.toUpperCase());
}

/** every (a, b) pair, interleaved so a cap keeps breadth over the first list. */
export function crossCapped<A, B>(as: A[], bs: B[], max = MAX_TARGETS_PER_QUERY): Array<[A, B]> {
  const out: Array<[A, B]> = [];
  for (let bi = 0; bi < bs.length && out.length < max; bi++) {
    for (let ai = 0; ai < as.length && out.length < max; ai++) out.push([as[ai]!, bs[bi]!]);
  }
  return out;
}

export function capTargets(ts: FetchTarget[], max = MAX_TARGETS_PER_QUERY): FetchTarget[] {
  return ts.slice(0, max);
}

/** a soft years-of-experience window around the searcher's own (sources' exp facets). */
export function expWindow(yoe: number): { min: number; max: number } {
  const y = Math.max(0, Math.round(yoe));
  return { min: Math.max(0, y - 1), max: y + 2 };
}

/** query seniority → the lowest band asked for (or null). */
export function lowestBand(bands: readonly LevelBand[]): LevelBand | null {
  const order: LevelBand[] = ["intern", "junior", "mid", "senior", "staff", "lead", "principal", "manager", "director"];
  for (const b of order) if (bands.includes(b)) return b;
  return null;
}

export function slugifyTerm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
