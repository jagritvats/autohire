import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, liveFromStatus, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";

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
  secondaryLocations?: Array<{ location?: string }>;
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

  /**
   * The hosted job page answers 404 for a posting that isn't on the board (checked live
   * 2026-11-18: a listed id → 200, an unknown id → 404). The posting API has no public
   * per-job route (401), so the page is the check.
   */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.slug || !/^[0-9a-f-]{36}$/i.test(job.jobId)) return null;
    return liveFromStatus(await httpStatus(`https://jobs.ashbyhq.com/${encodeURIComponent(job.slug)}/${job.jobId}`, { headers: { Accept: "text/html" } }));
  }

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
        locationRaw: ashbyLocation(j),
        applyUrl: j.applyUrl ?? j.jobUrl ?? null,
        salaryRaw,
        postedAt: j.publishedAt ?? null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}

/**
 * Primary + secondary locations. Global boards often list a US city first and
 * "Bengaluru" as a secondary — dropping those hid India-workable roles (§11.3).
 */
function ashbyLocation(j: AshbyJob): string | null {
  const all = [j.location, ...(j.secondaryLocations ?? []).map((l) => l.location)].filter(Boolean);
  const joined = [...new Set(all)].join("; ");
  if (j.isRemote) return `Remote ${joined}`.trim();
  return joined || null;
}
