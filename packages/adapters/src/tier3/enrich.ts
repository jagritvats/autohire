import { parseTitle } from "@jobflow/core";
import type { Enrichment, EnrichmentCompRole } from "../types.js";
import {
  asNumber,
  collectObjects,
  extractNextData,
  extractAssignedJson,
  jsonLdOfType,
  pick,
  tryParseJson,
} from "./parse.js";

/**
 * Tier-3 employer enrichment parsers (§11.5) — ratings + India comp. Pure HTML/JSON →
 * Enrichment; the local agent injects the actual fetch. AmbitionBox (Naukri-owned, no
 * login, SSR __NEXT_DATA__) is the primary, high-confidence source; Glassdoor (Apollo
 * cache, aggressive anti-bot) is best-effort and needs the user's logged-in session.
 * Every extractor is defensive: unknown fields stay null (never invented, never 0).
 */

// ── AmbitionBox ─────────────────────────────────────────────────────────────────

/** Company name → AmbitionBox slug (server 301-redirects a naive slug to canonical). */
export function ambitionBoxSlug(companyName: string): string {
  return companyName
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The overview page carries the full sub-category ratings + salaries in __NEXT_DATA__. */
export function buildAmbitionBoxUrl(companyName: string): string {
  return `https://www.ambitionbox.com/overview/${ambitionBoxSlug(companyName)}-overview`;
}

/**
 * Parse an AmbitionBox overview page. Primary anchor: `__NEXT_DATA__` (stable camelCase
 * keys survive redesigns). Cross-check / fallback: JSON-LD `EmployerAggregateRating`.
 */
export function parseAmbitionBox(html: string): Enrichment | null {
  if (!html) return null;
  const next = extractNextData(html);
  const ratings = next ? scanRatings(next) : null;

  // JSON-LD standard block (present on every page type) — overall + count.
  const ld = jsonLdOfType(html, "EmployerAggregateRating")[0] ?? aggregateRatingFromAnyLd(html);
  const ldOverall = ld ? asNumber(pick(ld, "ratingValue")) : null;
  const ldCount = ld ? asNumber(pick(ld, "ratingCount", "reviewCount")) : null;

  const overall = clampRating(ratings?.overall ?? ldOverall);
  const reviewCount = intOrNull(ratings?.reviewCount ?? ldCount);
  if (overall == null && reviewCount == null) return null; // nothing usable parsed

  const roles = next ? softwareCompRoles(next) : [];
  const ctcs = roles.flatMap((r) => [r.hi ?? r.median]);
  const comp = ctcs.length ? { min: Math.min(...ctcs), max: Math.max(...ctcs) } : null;

  return {
    source: "ambitionbox",
    ratingOverall: overall ?? undefined,
    ratingWlb: clampRating(ratings?.wlb) ?? undefined,
    ratingComp: clampRating(ratings?.comp) ?? undefined,
    reviewCount: reviewCount ?? undefined,
    cultureSummary: buildCultureSummary("AmbitionBox", overall, reviewCount, ratings) ?? undefined,
    salaryMin: comp?.min,
    salaryMax: comp?.max,
    currency: comp ? "INR" : undefined,
    compRoles: roles.length ? roles : undefined,
  };
}

/**
 * Per-designation software CTC (absolute INR, not LPA) — kept PER ROLE so the estimator can
 * price a senior posting off "Senior Software Engineer" rather than an all-titles spread.
 * The level comes from the designation title via the same title parser the postings use.
 */
function softwareCompRoles(root: unknown): EnrichmentCompRole[] {
  const nodes = collectObjects(
    root,
    (o) =>
      (o.avgCtc != null || o.typicalMaxCtc != null || o.medianCtc != null) &&
      /engineer|sde|developer|software|programmer|technical/i.test(roleTitle(o)),
    400,
  );
  const inr = (v: unknown) => {
    const n = asNumber(v);
    return n != null && n >= 100_000 ? n : null; // ≥ 1 LPA sanity; an LPA-unit field is never scaled up
  };
  const seen = new Set<string>();
  const out: EnrichmentCompRole[] = [];
  for (const o of nodes) {
    const title = roleTitle(o).trim();
    const lo = inr(pick(o, "typicalMinCtc", "minCtc", "minimumCtc"));
    const hi = inr(pick(o, "typicalMaxCtc", "maxCtc", "maximumCtc"));
    const median = inr(pick(o, "avgCtc", "medianCtc")) ?? (lo != null && hi != null ? Math.sqrt(lo * hi) : hi);
    if (!title || median == null || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const n = asNumber(pick(o, "salariesCount", "salaryCount", "dataPoints", "count"));
    out.push({ title, levelBand: parseTitle(title).levelBand, median, lo, hi, n: n != null ? Math.round(n) : null });
  }
  return out.sort((a, b) => a.median - b.median); // the JSON walk order is arbitrary
}

function roleTitle(o: Record<string, unknown>): string {
  return String(o.title ?? o.designation ?? o.jobProfile ?? o.name ?? o.designationName ?? "");
}

// ── Glassdoor ───────────────────────────────────────────────────────────────────

/** Autocomplete endpoint that resolves a company name → numeric employer id (JSON). */
export function buildGlassdoorFindUrl(companyName: string): string {
  const term = encodeURIComponent(companyName.trim());
  return `https://www.glassdoor.co.in/api-web/employer/find.htm?autocomplete=true&maxEmployersForAutocomplete=10&term=${term}`;
}

/** Pick the best employer id from the autocomplete JSON (exact-name match, else most reviews). */
export function resolveGlassdoorEmployerId(findJson: string, companyName: string): string | null {
  const parsed = tryParseJson<unknown>(findJson);
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { employers?: unknown[] })?.employers)
      ? (parsed as { employers: unknown[] }).employers
      : [];
  const want = norm(companyName);
  let best: { id: string; reviews: number; exact: boolean } | null = null;
  for (const e of arr as Record<string, unknown>[]) {
    const id = asNumber(pick(e, "id", "employerId"));
    if (id == null) continue;
    const name = String(pick(e, "name", "shortName", "label") ?? "");
    const reviews = asNumber(pick(e, "reviewCount", "numberOfRatings", "reviews")) ?? 0;
    const exact = norm(name) === want;
    if (!best || (exact && !best.exact) || (exact === best.exact && reviews > best.reviews)) {
      best = { id: String(Math.round(id)), reviews, exact };
    }
  }
  return best?.id ?? null;
}

/** Overview URL; char-offsets are omitted on purpose (Glassdoor 301s to canonical). */
export function buildGlassdoorOverviewUrl(companyName: string, employerId: string): string {
  const slug = companyName.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `https://www.glassdoor.co.in/Overview/Working-at-${slug}-EI_IE${employerId}.htm`;
}

/**
 * Parse a Glassdoor overview page. Primary anchor: the hydrated Apollo cache embedded in
 * `__NEXT_DATA__` (or `window.__APOLLO_STATE__`) — the same data the UI renders. Fallback:
 * JSON-LD `AggregateRating`.
 */
export function parseGlassdoor(html: string): Enrichment | null {
  if (!html) return null;
  const apollo =
    apolloFromNextData(html) ??
    extractAssignedJson(html, /["']?apolloState["']?\s*:\s*/) ??
    extractAssignedJson(html, /window\.__APOLLO_STATE__\s*=\s*/);
  const ratings = apollo ? scanRatings(apollo) : null;

  const ld = jsonLdOfType(html, "AggregateRating")[0] ?? aggregateRatingFromAnyLd(html);
  const ldOverall = ld ? asNumber(pick(ld, "ratingValue")) : null;
  const ldCount = ld ? asNumber(pick(ld, "ratingCount", "reviewCount")) : null;

  const overall = clampRating(ratings?.overall ?? ldOverall);
  const reviewCount = intOrNull(ratings?.reviewCount ?? ldCount);
  if (overall == null && reviewCount == null) return null;

  return {
    source: "glassdoor",
    ratingOverall: overall ?? undefined,
    ratingWlb: clampRating(ratings?.wlb) ?? undefined,
    ratingComp: clampRating(ratings?.comp) ?? undefined,
    reviewCount: reviewCount ?? undefined,
    cultureSummary: buildCultureSummary("Glassdoor", overall, reviewCount, ratings) ?? undefined,
    interviewDifficulty: interviewDifficultyLabel(apollo) ?? undefined,
  };
}

function apolloFromNextData(html: string): Record<string, unknown> | null {
  const next = extractNextData(html);
  if (!next) return null;
  const pageProps = pluck(next, "props", "pageProps");
  if (pageProps && typeof pageProps === "object") {
    const cache = pick(pageProps as Record<string, unknown>, "apolloCache", "apolloState", "initialApolloState");
    if (cache && typeof cache === "object") return cache as Record<string, unknown>;
  }
  return next;
}

function interviewDifficultyLabel(apollo: Record<string, unknown> | null): string | null {
  if (!apollo) return null;
  const nodes = collectObjects(apollo, (o) => o.difficultyRating != null || o.difficulty != null, 300);
  const d = nodes.map((o) => asNumber(pick(o, "difficultyRating", "difficulty"))).find((n) => n != null && n > 0 && n <= 5);
  if (d == null) return null;
  return d < 2.3 ? `easy (${d.toFixed(1)}/5)` : d > 3.2 ? `hard (${d.toFixed(1)}/5)` : `average (${d.toFixed(1)}/5)`;
}

// ── shared rating extraction ─────────────────────────────────────────────────────

interface Ratings {
  overall: number | null;
  wlb: number | null;
  comp: number | null;
  culture: number | null;
  reviewCount: number | null;
}

/**
 * Walk a JSON tree and pull rating fields by FUZZY key match, choosing the node with the
 * best coverage + a plausible overall rating. Resilient to exact-key drift across both
 * AmbitionBox (__NEXT_DATA__) and Glassdoor (Apollo) shapes.
 */
function scanRatings(root: unknown): Ratings | null {
  let best: Ratings | null = null;
  let bestScore = -1;
  for (const o of collectObjects(root, () => true, 4000)) {
    const overall = ratingByKey(o, /^(overallrating|rating|ratingvalue|starrating|avgrating)$/i);
    const wlb = ratingByKey(o, /worklife|work_life|wlb/i);
    const comp = ratingByKey(o, /compensation|salaryandbenefit|salarybenefit|compbenefit/i);
    const culture = ratingByKey(o, /cultureandvalue|companyculture|culture/i);
    const reviewCount = intByKey(o, /reviewscount|reviewcount|ratingcount|totalreviews|numberofratings|filteredreviewscount/i);
    const coverage = [overall, wlb, comp, culture, reviewCount].filter((v) => v != null).length;
    if (overall == null && reviewCount == null) continue;
    // prefer nodes that actually carry an overall rating, then higher coverage
    const score = coverage + (overall != null ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { overall, wlb, comp, culture, reviewCount };
    }
  }
  return best;
}

function ratingByKey(o: Record<string, unknown>, keyRe: RegExp): number | null {
  for (const [k, v] of Object.entries(o)) {
    if (!keyRe.test(k.replace(/[^a-z0-9]/gi, ""))) continue;
    const n = asNumber(v);
    if (n != null && n > 0 && n <= 5) return round1(n);
  }
  return null;
}

function intByKey(o: Record<string, unknown>, keyRe: RegExp): number | null {
  for (const [k, v] of Object.entries(o)) {
    if (!keyRe.test(k.replace(/[^a-z0-9]/gi, ""))) continue;
    const n = asNumber(v);
    if (n != null && n >= 0 && Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

/** Any JSON-LD object exposing an `aggregateRating` (unwrap it). */
function aggregateRatingFromAnyLd(html: string): Record<string, unknown> | null {
  for (const node of jsonLdOfType(html, "Organization").concat(jsonLdOfType(html, "Corporation"))) {
    const ar = pick(node, "aggregateRating");
    if (ar && typeof ar === "object") return ar as Record<string, unknown>;
  }
  return null;
}

function buildCultureSummary(
  label: string,
  overall: number | null,
  reviewCount: number | null,
  r: Ratings | null,
): string | null {
  if (overall == null && !r) return null;
  const parts: string[] = [];
  if (overall != null) parts.push(`${overall.toFixed(1)}★`);
  if (reviewCount != null) parts.push(`${formatCount(reviewCount)} reviews`);
  if (r?.wlb != null) parts.push(`WLB ${r.wlb.toFixed(1)}`);
  if (r?.comp != null) parts.push(`comp ${r.comp.toFixed(1)}`);
  if (r?.culture != null) parts.push(`culture ${r.culture.toFixed(1)}`);
  return parts.length ? `${label}: ${parts.join(" · ")}` : null;
}

function clampRating(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n) || n <= 0 || n > 5) return null;
  return round1(n);
}
function intOrNull(n: number | null | undefined): number | null {
  return n != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function formatCount(n: number): string {
  if (n >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function pluck(obj: Record<string, unknown>, a: string, b: string): unknown {
  const inner = pick(obj, a);
  if (inner && typeof inner === "object") return pick(inner as Record<string, unknown>, b);
  return undefined;
}
