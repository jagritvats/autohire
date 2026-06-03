import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Ashby public posting API (Tier 1, free, no auth). Verified live:
 *   GET https://api.ashbyhq.com/posting-api/job-board/{boardName}?includeCompensation=true
 * boardName is case-sensitive (e.g. "openai", "Deel", "Linear", "ramp").
 */

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  isRemote?: boolean;
  descriptionPlain?: string;
  descriptionHtml?: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  compensation?: {
    compensationTierSummary?: string;
    summaryComponents?: Array<{ summary?: string }>;
  };
}
interface AshbyResponse {
  jobs: AshbyJob[];
}

export class AshbyAdapter implements SourceAdapter {
  readonly source = "ashby" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
    const data = await httpJson<AshbyResponse>(url);
    if (!data?.jobs) return [];

    const jobs = target.limit ? data.jobs.slice(0, target.limit) : data.jobs;
    return jobs.map((j) => {
      const jdText = j.descriptionPlain || htmlToText(j.descriptionHtml);
      const salaryRaw =
        j.compensation?.compensationTierSummary ??
        j.compensation?.summaryComponents?.map((c) => c.summary).filter(Boolean).join(" / ") ??
        null;
      return {
        source: "ashby",
        tier: "tier1",
        atsType: "ashby",
        atsJobId: j.id,
        companyName: slug,
        companySlug: slug,
        title: j.title,
        jdText,
        jdHtml: j.descriptionHtml ?? null,
        locationRaw: j.isRemote ? `Remote ${j.location ?? ""}`.trim() : j.location ?? null,
        applyUrl: j.applyUrl ?? j.jobUrl ?? null,
        salaryRaw,
        postedAt: j.publishedAt ?? null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
