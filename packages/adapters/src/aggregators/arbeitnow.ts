import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

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
}

export class ArbeitnowAdapter implements SourceAdapter {
  readonly source = "arbeitnow" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const data = await httpJson<AnResponse>("https://www.arbeitnow.com/api/job-board-api");
    if (!data?.data) return [];
    let jobs = data.data;
    if (target.query) {
      const q = target.query.toLowerCase();
      jobs = jobs.filter(
        (j) => j.title.toLowerCase().includes(q) || (j.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (target.limit) jobs = jobs.slice(0, target.limit);

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
      locationRaw: j.remote ? `Remote ${j.location ?? ""}`.trim() : j.location ?? null,
      applyUrl: j.url ?? null,
      salaryRaw: null,
      postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
      fetchedAt: new Date(),
      raw: j as unknown as Record<string, unknown>,
    }));
  }
}
