import type { Posting } from "../schema/entities.js";
import { LevelBandOrder, type RemoteGeo } from "../schema/enums.js";
import { SearchQuery, type SearchQueryInput, type ViewHiddenReason } from "../schema/search.js";
import { extractSkills } from "../normalize/skills.js";
import { normCompany } from "../normalize/titles.js";
import { isWorkableIn, locationInCountry } from "../normalize/location.js";
import { postingAgeDays } from "./score.js";

/**
 * Saved-search VIEWS (product plan "Views vs ranking", invariant #4). A view is the user's
 * explicit filter over their ranked feed — so it may hide, but only on values we know
 * CONFIDENTLY, and it always says how much it hid and why:
 *  - location/remote: only when the parsed location's confidence ≥ 0.85;
 *  - salary: only a stated, high-confidence CEILING in the query's own currency;
 *  - seniority: only when the posting has a level band;
 *  - age: `postingAgeDays` is a lower bound on the real age (earliest of the source date
 *    and our first sighting), so "older than N days" is always known;
 *  - must-have skills: only when the JD's skills were parsed (non-empty);
 *  - company / keyword exclusions: the user named them.
 * Unknown values always pass, nice-to-have skills never hide, and nothing is rescored or
 * mutated — `applyView` only partitions the list it's given.
 */

export const VIEW_LOCATION_CONFIDENCE = 0.85;

export interface ViewOptions {
  /** clock for the age check (tests). */
  now?: number;
  /** override the location-confidence bar (default 0.85). */
  locationConfidence?: number;
  /**
   * the discovery presets a posting belongs to (its company is in a preset's seed list, or
   * it came from a preset's feed). Needed only when the query filters by `presets`.
   */
  presetsOf?: (posting: Posting) => readonly string[];
}

export interface ViewResult<T> {
  shown: T[];
  /** hidden count per reason — every hidden item is counted under exactly one. */
  hidden: Record<ViewHiddenReason, number>;
  hiddenTotal: number;
}

/**
 * Order the reasons are checked in; a match failing several is counted under the first.
 * The user's explicit exclusions come first (they're the most definite), then the facets.
 */
export const VIEW_REASON_ORDER: readonly ViewHiddenReason[] = [
  "preset",
  "company",
  "keyword",
  "location",
  "remote",
  "seniority",
  "salary",
  "age",
  "skill",
];

export function emptyHiddenCounts(): Record<ViewHiddenReason, number> {
  return { preset: 0, location: 0, remote: 0, seniority: 0, salary: 0, age: 0, company: 0, keyword: 0, skill: 0 };
}

/** Partition matches into shown/hidden by a view. Order of `shown` is preserved. */
export function applyView<T extends { posting: Posting }>(
  matches: readonly T[],
  queryInput: SearchQuery | SearchQueryInput,
  opts: ViewOptions = {},
): ViewResult<T> {
  const query = SearchQuery.parse(queryInput);
  const hidden = emptyHiddenCounts();
  const shown: T[] = [];
  let hiddenTotal = 0;
  for (const m of matches) {
    const reason = viewHideReason(m.posting, query, opts);
    if (reason) {
      hidden[reason]++;
      hiddenTotal++;
    } else {
      shown.push(m);
    }
  }
  return { shown, hidden, hiddenTotal };
}

/** The first reason a view would hide this posting, or null if it passes. */
export function viewHideReason(posting: Posting, query: SearchQuery, opts: ViewOptions = {}): ViewHiddenReason | null {
  const bar = opts.locationConfidence ?? VIEW_LOCATION_CONFIDENCE;
  const loc = posting.location;
  const locKnown = loc.confidence >= bar;

  // preset — a tag filter: the posting must belong to one of the chosen presets
  if (query.presets.length && opts.presetsOf) {
    const tags = opts.presetsOf(posting);
    if (!query.presets.some((p) => tags.includes(p))) return "preset";
  }

  // company — the user excluded it by name
  if (query.excludeCompanies.length) {
    const co = normCompany(posting.companyName);
    if (co && query.excludeCompanies.some((c) => normCompany(c) === co)) return "company";
  }

  // keyword — an excluded word in the title (or a parsed skill); JD prose is not used:
  // "we are not a crypto company" must not hide a role excluded for "crypto"
  if (query.excludeKeywords.length) {
    const hay = `${posting.title} ${posting.jdSkills.join(" ")}`;
    if (query.excludeKeywords.some((k) => containsWord(hay, k))) return "keyword";
  }

  // location — onsite/hybrid must be in one of the places; remote must be open to one of
  // the query's countries (when no explicit remote-geo filter decides that instead)
  if (query.locations.length && locKnown) {
    if (loc.mode === "onsite" || loc.mode === "hybrid") {
      if (!query.locations.some((q) => placeMatches(posting, q))) return "location";
    } else if (loc.mode === "remote" && !query.remoteGeo.length && loc.remoteGeo !== "unknown") {
      const countries = query.locations.map((q) => q.country).filter((c): c is string => !!c);
      if (countries.length && !isWorkableIn(loc, countries)) return "location";
    }
  }

  // remote — only / exclude / an explicit set of remote geos
  if (locKnown) {
    if (query.remote === "only" && (loc.mode === "onsite" || loc.mode === "hybrid")) return "remote";
    if (query.remote === "exclude" && loc.mode === "remote") return "remote";
    if (query.remoteGeo.length && loc.mode === "remote" && loc.remoteGeo !== "unknown" && !query.remoteGeo.includes(loc.remoteGeo as RemoteGeo)) {
      return "remote";
    }
  }

  // seniority — only a parsed band
  if (query.seniority.length && posting.levelBand && !query.seniority.includes(posting.levelBand)) return "seniority";

  // salary — a stated, high-confidence ceiling in the same currency, below the minimum
  if (query.minSalary) {
    const s = posting.salary;
    if (
      s.source !== "none" &&
      s.confidence === "high" &&
      s.max != null &&
      s.currency.toUpperCase() === query.minSalary.currency.toUpperCase() &&
      s.max < query.minSalary.amount
    ) {
      return "salary";
    }
  }

  // age — a lower bound on the real age, so "older than N days" is known
  if (query.postedWithinDays != null && postingAgeDays(posting, opts.now) > query.postedWithinDays) return "age";

  // must-have skills — only when the JD's skills were parsed
  if (query.mustSkills.length && posting.jdSkills.length) {
    if (!query.mustSkills.every((s) => hasSkill(posting, s))) return "skill";
  }
  return null;
}

/**
 * How well a posting answers the query's positive terms ∈ [0,1] — for an optional
 * "sort by search relevance". Separate from the match score, which it never changes.
 * Parts the query doesn't use don't count; an empty query scores 0.5 for everything.
 */
export function searchRelevance(posting: Posting, queryInput: SearchQuery | SearchQueryInput): number {
  const q = SearchQuery.parse(queryInput);
  const parts: Array<[number, number]> = []; // [weight, value]
  const terms = [...q.titles, ...q.keywords].filter((t) => t.trim());
  if (terms.length) {
    const titleHit = terms.some((t) => containsPhrase(posting.title, t));
    const jdHit = terms.filter((t) => containsPhrase(posting.jdText.slice(0, 4000), t)).length / terms.length;
    parts.push([0.4, titleHit ? 1 : 0.6 * jdHit]);
  }
  if (q.mustSkills.length) parts.push([0.25, q.mustSkills.filter((s) => hasSkill(posting, s)).length / q.mustSkills.length]);
  if (q.niceSkills.length) parts.push([0.15, q.niceSkills.filter((s) => hasSkill(posting, s)).length / q.niceSkills.length]);
  if (q.locations.length) {
    const loc = posting.location;
    const hit =
      loc.mode === "remote"
        ? q.remote !== "exclude"
        : (loc.country != null || loc.city != null) && q.locations.some((l) => placeMatches(posting, l));
    parts.push([0.1, hit ? 1 : 0]);
  }
  if (q.seniority.length) {
    const band = posting.levelBand;
    const v = !band
      ? 0.5
      : q.seniority.includes(band)
        ? 1
        : Math.max(0, 1 - 0.35 * Math.min(...q.seniority.map((s) => Math.abs(LevelBandOrder[s] - LevelBandOrder[band]))));
    parts.push([0.1, v]);
  }
  const total = parts.reduce((s, [w]) => s + w, 0);
  if (!total) return 0.5;
  return Math.max(0, Math.min(1, parts.reduce((s, [w, v]) => s + w * v, 0) / total));
}

// ── helpers ──

const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru",
  gurgaon: "gurugram",
  bombay: "mumbai",
  madras: "chennai",
  "new delhi": "delhi",
  secunderabad: "hyderabad",
  cochin: "kochi",
  mysore: "mysuru",
  nyc: "new york",
  "new york city": "new york",
  sf: "san francisco",
  münchen: "munich",
};
function normCity(c: string): string {
  const s = c.trim().toLowerCase().replace(/\s+/g, " ");
  return CITY_ALIASES[s] ?? s;
}

/** onsite place vs one query location; anything the posting doesn't state passes. */
function placeMatches(posting: Posting, q: { city: string | null; country: string | null }): boolean {
  const loc = posting.location;
  if (q.country && locationInCountry(loc, q.country) === false) return false; // any of its countries
  if (q.city && loc.city) {
    const a = normCity(loc.city);
    const b = normCity(q.city);
    if (a !== b && !a.includes(b) && !b.includes(a)) return false;
  }
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWord(hay: string, word: string): boolean {
  const w = word.trim();
  if (!w) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, "iu").test(hay);
}

/** every word of the phrase present (order-free) — "staff backend" hits "Backend Engineer, Staff". */
function containsPhrase(hay: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => containsWord(hay, w));
}

/** a skill counts if it's a parsed skill (canonical form) or named in the title/JD. */
function hasSkill(posting: Posting, skill: string): boolean {
  const canon = extractSkills(skill);
  if (canon.length && canon.every((c) => posting.jdSkills.includes(c))) return true;
  if (posting.jdSkills.some((s) => s.toLowerCase() === skill.trim().toLowerCase())) return true;
  return containsWord(`${posting.title}\n${posting.jdText}`, skill);
}

// ── company spread: a presentation ORDER over the ranked list ─────────────────────────

/** In any run of this many consecutive cards… */
export const DIVERSIFY_WINDOW = 20;
/** …at most this many come from one company. */
export const DIVERSIFY_PER_COMPANY = 3;

export interface DiversifyOptions {
  window?: number;
  perCompany?: number;
}

/**
 * Spread a ranked list so a few big employers don't fill the page (audit 2026-11: with false
 * merges gone, Amazon held 19 of an India top 50). Greedy and stable: each position takes
 * the best-ranked remaining item whose company has fewer than `perCompany` items in the
 * last `window - 1` positions; when only capped companies remain it takes the best one
 * anyway. So nothing is dropped, scores are untouched, every company's own items keep their
 * order, and the cards it moves down follow a little later (invariant #4: a view, not a
 * score and not a filter — callers keep a "score order only" switch).
 */
export function diversifyByCompany<T>(items: readonly T[], companyOf: (item: T) => string, opts: DiversifyOptions = {}): T[] {
  const window = Math.max(1, opts.window ?? DIVERSIFY_WINDOW);
  const cap = Math.max(1, opts.perCompany ?? DIVERSIFY_PER_COMPANY);
  const pending = items.map((item, i) => ({ item, key: companyOf(item) || `#${i}` }));
  const out: T[] = [];
  const placed: string[] = [];
  const inWindow = new Map<string, number>();
  while (pending.length) {
    let pick = pending.findIndex((p) => (inWindow.get(p.key) ?? 0) < cap);
    if (pick === -1) pick = 0;
    const [next] = pending.splice(pick, 1);
    out.push(next!.item);
    placed.push(next!.key);
    inWindow.set(next!.key, (inWindow.get(next!.key) ?? 0) + 1);
    // the window for the NEXT position drops the item `window - 1` places back
    if (placed.length >= window) {
      const old = placed[placed.length - window]!;
      inWindow.set(old, (inWindow.get(old) ?? 1) - 1);
    }
  }
  return out;
}

/** The company key the spread groups by: the normalized name, so a board and an aggregator agree. */
export function diversifyKey(company: string): string {
  return normCompany(company);
}
