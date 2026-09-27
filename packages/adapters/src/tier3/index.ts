import type { ExecutionTier, RawPosting, SourceKind } from "@jobflow/core";
import type { Enrichment, EnrichmentInput, FetchTarget, SourceAdapter } from "../types.js";
import { buildNaukriApiUrl, buildNaukriSeoUrl, naukriApiHeaders, parseNaukriApiJson, parseNaukriHtml, type NaukriSearchOptions } from "./naukri.js";
import { buildLinkedInUrl, parseLinkedInJobs } from "./linkedin.js";
import {
  buildAmbitionBoxUrl,
  buildGlassdoorFindUrl,
  buildGlassdoorOverviewUrl,
  parseAmbitionBox,
  parseGlassdoor,
  resolveGlassdoorEmployerId,
} from "./enrich.js";

/**
 * Tier-3 sources (§1, §7.1): Naukri, AmbitionBox, Glassdoor, LinkedIn. No free API,
 * scrape-hostile. These run EXCLUSIVELY on the local agent, through the user's OWN
 * authenticated browser session, polite-paced, flag-guarded OFF by default. The
 * cloud orchestrator never imports or runs these (they're absent from the cloud
 * registry on purpose, invariant #1).
 *
 * The page-scraping is provided by the local runner (an injected `localFetch` /
 * `localFetchJson` bound to a Playwright page in the user's session). These classes own
 * the URL construction + the guard + the pure HTML/JSON → RawPosting parsing; the
 * network + session live entirely on the agent, so server bundles never fetch anything.
 */

export class Tier3DisabledError extends Error {}

export interface Tier3Context {
  /** opt-in source list from JOBFLOW_TIER3_SOURCES (csv) */
  enabledSources: string[];
  /** fetch+parse a page in the user's local session (rendered HTML); injected by the
   *  local agent. Absent server-side → adapter refuses to run. */
  localFetch?: (url: string) => Promise<string>;
  /** replay a site's own JSON/XHR endpoint from inside a first-party page (session
   *  cookies + custom headers). Enables Naukri's jobapi + Glassdoor id resolution. */
  localFetchJson?: (url: string, headers?: Record<string, string>) => Promise<string>;
}

abstract class LocalTier3Adapter implements SourceAdapter {
  abstract readonly source: SourceKind;
  readonly tier: ExecutionTier = "tier3";
  constructor(protected ctx: Tier3Context) {}

  protected assertEnabled(): void {
    if (!this.ctx.localFetch) {
      throw new Tier3DisabledError(
        `${this.source} is Tier 3 — runs only on the local agent with your session. No localFetch injected.`,
      );
    }
    if (!this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(
        `${this.source} not in JOBFLOW_TIER3_SOURCES. Opt in per source (default off).`,
      );
    }
  }

  abstract fetch(target: FetchTarget): Promise<RawPosting[]>;
}

/** Naukri: India's largest board — the primary good-paying-SWE-in-India source. Bonus:
 *  each jobapi card carries the AmbitionBox rating, so a single pass yields jobs +
 *  ratings (§11.5). Prefers the internal JSON API; falls back to the rendered SRP DOM. */
export class NaukriAdapter extends LocalTier3Adapter {
  readonly source = "naukri" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const opts: NaukriSearchOptions = {
      query: target.query ?? "software engineer",
      location: target.location ?? "",
      minLpa: numParam(target, "minLpa"),
      freshnessDays: numParam(target, "freshnessDays"),
      experienceYears: numParam(target, "experienceYears"),
    };
    const limit = target.limit ?? 25;
    // best path: replay the SRP's own JSON (needs appid/systemid headers → localFetchJson)
    if (this.ctx.localFetchJson) {
      const body = await this.ctx.localFetchJson(
        buildNaukriApiUrl({ ...opts, pageSize: Math.max(limit, 20) }),
        naukriApiHeaders(),
      );
      const jobs = parseNaukriApiJson(body, limit);
      if (jobs.length) return jobs;
    }
    // fallback: parse the rendered search-results DOM
    const html = await this.ctx.localFetch!(buildNaukriSeoUrl(opts));
    return parseNaukriHtml(html, limit);
  }
}

/** LinkedIn: fetched via the static guest job-search fragment (the auth Voyager list is
 *  virtualized), through the user's session. India geo + experience-level facet. */
export class LinkedInAdapter extends LocalTier3Adapter {
  readonly source = "linkedin" as const;
  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    this.assertEnabled();
    const url = buildLinkedInUrl({
      query: target.query ?? "software engineer",
      location: target.location ?? "",
      freshnessDays: numParam(target, "freshnessDays"),
      experienceYears: numParam(target, "experienceYears"),
    });
    const html = await this.ctx.localFetch!(url);
    return parseLinkedInJobs(html, target.limit ?? 25);
  }
}

/** AmbitionBox / Glassdoor are enrichment sources (ratings + India comp), not job spines. */
abstract class LocalTier3Enricher {
  readonly tier: ExecutionTier = "tier3";
  abstract readonly source: SourceKind;
  constructor(protected ctx: Tier3Context) {}
  protected assertEnabled(): void {
    if (!this.ctx.localFetch || !this.ctx.enabledSources.includes(this.source)) {
      throw new Tier3DisabledError(`${this.source} disabled / not local.`);
    }
  }
  abstract enrich(input: EnrichmentInput): Promise<Enrichment | null>;
}

/** AmbitionBox (Naukri-owned, no login, SSR __NEXT_DATA__) — the primary ratings + India
 *  comp source. Slug is derived from the name; the site 301s to the canonical page. */
export class AmbitionBoxEnricher extends LocalTier3Enricher {
  readonly source = "ambitionbox" as const;
  async enrich(input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    const html = await this.ctx.localFetch!(buildAmbitionBoxUrl(input.companyName));
    return parseAmbitionBox(html);
  }
}

/** Glassdoor — best-effort (aggressive anti-bot). Needs `localFetchJson` to resolve the
 *  numeric employer id from the name; then parses the Overview page's Apollo cache. */
export class GlassdoorEnricher extends LocalTier3Enricher {
  readonly source = "glassdoor" as const;
  async enrich(input: EnrichmentInput): Promise<Enrichment | null> {
    this.assertEnabled();
    if (!this.ctx.localFetchJson) return null; // id resolution needs a headered JSON fetch
    const findJson = await this.ctx.localFetchJson(buildGlassdoorFindUrl(input.companyName), { Accept: "application/json" });
    const employerId = resolveGlassdoorEmployerId(findJson, input.companyName);
    if (!employerId) return null;
    const html = await this.ctx.localFetch!(buildGlassdoorOverviewUrl(input.companyName, employerId));
    return parseGlassdoor(html);
  }
}

/** Read a numeric free-form FetchTarget param (minLpa / freshnessDays). */
function numParam(target: FetchTarget, key: string): number | undefined {
  const v = target.params?.[key];
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
