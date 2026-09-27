/**
 * India software/engineering Tier-3 poll targeting (§7.1, §11) — the "good-paying SWE
 * in India" sweep. Pure config + helpers shared by the Tier-3 adapters (URL building)
 * and the local agent's `tier3_poll` handler (target planning).
 *
 * Invariant #4: biasing the SOURCE query toward higher-CTC roles and Indian tech hubs
 * shapes WHAT we poll — it is not a hard match filter. The matcher still weights
 * salary/location/stack with honest flags; nothing here excludes a role from the feed.
 */

/** Indian tech hubs to sweep for onsite/hybrid roles (URL-slug friendly, lowercase). */
export const INDIA_TECH_HUBS = [
  "bengaluru",
  "pune",
  "hyderabad",
  "gurgaon",
  "noida",
  "chennai",
  "mumbai",
  "delhi",
] as const;
export type IndiaTechHub = (typeof INDIA_TECH_HUBS)[number];

/**
 * Curated software / engineering search queries, biased to strong IC + platform roles
 * (the archetypes the default profile targets). Order matters: the sweep takes the
 * first N when capped, so the highest-signal queries lead.
 */
export const INDIA_SWE_QUERIES = [
  "software engineer",
  "backend engineer",
  "sde 2",
  "platform engineer",
  "full stack developer",
  "java developer",
  "devops engineer",
  "data engineer",
] as const;

/** One concrete thing to poll: a (query × location) cell with soft targeting knobs. */
export interface Tier3PollTarget {
  /** free-text keyword query (e.g. "backend engineer"). */
  query: string;
  /** India hub slug for an onsite/hybrid facet; "" = a remote / location-agnostic pass. */
  location: string;
  /** soft CTC floor in LPA (lakhs/annum) — biases the search, never a hard filter. */
  minLpa: number;
  /** only consider postings seen within this many days (recency facet). */
  freshnessDays: number;
  /** max cards to pull for this cell (politeness / cost). */
  limit: number;
  /** candidate YoE → the source's experience facet (soft: shapes the query only). */
  experienceYears?: number;
}

export interface Tier3PollOptions {
  /** override the query set (else INDIA_SWE_QUERIES). */
  queries?: string[];
  /** override the hub set (else INDIA_TECH_HUBS). */
  locations?: string[];
  /** soft CTC floor in LPA; default 15. */
  minLpa?: number;
  /** recency window in days; default 15. */
  freshnessDays?: number;
  /** cards per (query × location) cell; default 25. */
  limitPerTarget?: number;
  /** hard cap on total cells for politeness (sequential, human-paced); default 8. */
  maxTargets?: number;
  /** include a remote / location-agnostic pass per query (location: ""); default true. */
  remote?: boolean;
  /** candidate YoE for the experience facet; omitted → no facet. */
  experienceYears?: number;
}

/**
 * Derive a soft LPA floor from a profile's INR salary floor (`prefs.salaryFloor`).
 * 20,00,000 INR → 20 LPA. Clamped to a sane band so a blank/zero floor still targets
 * genuinely good-paying roles rather than everything.
 */
export function lpaFloorFromInr(salaryFloorInr: number | null | undefined, fallbackLpa = 15): number {
  const lpa = Math.round((salaryFloorInr ?? 0) / 100_000);
  if (!Number.isFinite(lpa) || lpa <= 0) return fallbackLpa;
  return Math.min(Math.max(lpa, 5), 100);
}

/**
 * Build the (query × location) target matrix for a good-paying India SWE sweep.
 * Interleaves locations across queries so a low `maxTargets` cap still yields breadth
 * (varied roles + cities) rather than one query in every city.
 */
export function buildIndiaSweTargets(opts: Tier3PollOptions = {}): Tier3PollTarget[] {
  const queries = dedupeNonEmpty(opts.queries ?? [...INDIA_SWE_QUERIES]);
  const hubs = dedupeNonEmpty(opts.locations ?? [...INDIA_TECH_HUBS]);
  const minLpa = opts.minLpa && opts.minLpa > 0 ? opts.minLpa : 15;
  const freshnessDays = opts.freshnessDays && opts.freshnessDays > 0 ? opts.freshnessDays : 15;
  const limit = opts.limitPerTarget && opts.limitPerTarget > 0 ? opts.limitPerTarget : 25;
  const maxTargets = opts.maxTargets && opts.maxTargets > 0 ? opts.maxTargets : 8;
  const remote = opts.remote ?? true;

  // per query, the location facets to try (a remote pass first, then hubs)
  const facetsFor = (): string[] => (remote ? ["", ...hubs] : [...hubs]);

  // interleave: (q0,f0), (q1,f0), … then (q0,f1), (q1,f1), … → breadth under a cap
  const targets: Tier3PollTarget[] = [];
  const facets = facetsFor();
  const seen = new Set<string>();
  for (let fi = 0; fi < facets.length && targets.length < maxTargets; fi++) {
    for (let qi = 0; qi < queries.length && targets.length < maxTargets; qi++) {
      const query = queries[qi]!;
      const location = facets[fi]!;
      const key = `${query}::${location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ query, location, minLpa, freshnessDays, limit, experienceYears: opts.experienceYears });
    }
  }
  return targets;
}

function dedupeNonEmpty(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of xs) {
    const s = raw.trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
