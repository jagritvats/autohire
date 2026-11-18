import type { RawPosting, SearchQuery } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { isEuropean, queryCountries, queryTerms } from "../search.js";

/**
 * Arbeitnow job board API (Tier 1, free, no auth):
 *   GET https://www.arbeitnow.com/api/job-board-api
 * Returns mostly EU + remote roles. Good for discovery → ATS Detector.
 */

interface AnJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number;
}
interface AnResponse {
  data: AnJob[];
  links?: { next?: string | null };
}

/** pages walked per fetch (politeness: ~2 MB each). */
const MAX_PAGES = 3;

export class ArbeitnowAdapter implements SourceAdapter {
  readonly source = "arbeitnow" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: false, remote: false, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /**
   * German-market board (mostly German-language, EU-onsite): only for a query in a
   * European market. One fetch returns the whole board, so one term is enough per call.
   */
  toTargets(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[] {
    if (!queryCountries(q, ctx).some(isEuropean)) return [];
    return queryTerms(q).map((term) => ({ query: term, limit: 60 }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    // The API has no search parameter: the query is a client-side filter over the newest
    // pages (300 jobs each, verified 2026-11). One page used to be all we read, so a
    // narrow term found a handful — walk a few pages until `limit` matches.
    const q = target.query?.toLowerCase();
    const limit = target.limit ?? 300; // no limit: one page, as before
    const seen = new Set<string>();
    let jobs: AnJob[] = [];
    for (let page = 1; page <= MAX_PAGES && jobs.length < limit; page++) {
      const data = await httpJson<AnResponse>(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      if (!data?.data) {
        if (page === 1) return [];
        break;
      }
      for (const j of data.data) {
        if (!j.slug || seen.has(j.slug)) continue;
        seen.add(j.slug);
        if (!q || j.title.toLowerCase().includes(q) || (j.tags ?? []).some((t) => t.toLowerCase().includes(q))) jobs.push(j);
      }
      if (!data.links?.next || data.data.length === 0) break;
    }
    jobs = jobs.slice(0, limit);

    return jobs.map((j) => ({
      source: "arbeitnow",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: j.slug,
      companyName: j.company_name,
      companySlug: null,
      title: j.title,
      jdText: htmlToText(j.description),
      jdHtml: j.description ?? null,
      locationRaw: j.remote ? `Remote ${j.location ?? ""}`.trim() : j.location?.trim() || null,
      applyUrl: j.url ?? null,
      salaryRaw: null,
      postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
      fetchedAt: new Date(),
      raw: j as unknown as Record<string, unknown>,
    }));
  }
}
