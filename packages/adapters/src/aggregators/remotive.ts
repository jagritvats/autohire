import type { RawPosting, SearchQuery } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { queryTerms } from "../search.js";

/**
 * Remotive (Tier 1, free, no auth). Remote-job aggregator; good discovery + surfaces
 * company names that the ATS Detector then resolves to a board.
 *   GET https://remotive.com/api/remote-jobs?search=...&category=software-dev&limit=...
 */

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
  publication_date?: string;
}
interface RemotiveResponse {
  jobs: RemotiveJob[];
}

export class RemotiveAdapter implements SourceAdapter {
  readonly source = "remotive" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: false, remote: true, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /** remote-only, keyword search: one target per term. */
  toTargets(q: SearchQuery, _ctx: SearchTargetContext): FetchTarget[] {
    if (q.remote === "exclude") return [];
    return queryTerms(q).map((term) => ({ query: term, limit: 50 }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const params = new URLSearchParams({ category: "software-dev" });
    if (target.query) params.set("search", target.query);
    if (target.limit) params.set("limit", String(target.limit));
    const data = await httpJson<RemotiveResponse>(
      `https://remotive.com/api/remote-jobs?${params}`,
    );
    if (!data?.jobs) return [];

    return data.jobs.map((j) => ({
      source: "remotive",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: String(j.id),
      companyName: j.company_name,
      companySlug: null,
      title: j.title,
      jdText: htmlToText(j.description),
      jdHtml: j.description ?? null,
      locationRaw: `Remote ${j.candidate_required_location ?? ""}`.trim(),
      applyUrl: j.url,
      salaryRaw: j.salary || null,
      postedAt: j.publication_date ?? null,
      fetchedAt: new Date(),
      raw: j as unknown as Record<string, unknown>,
    }));
  }
}
