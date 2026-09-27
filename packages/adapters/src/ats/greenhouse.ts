import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Greenhouse board API (Tier 1, free, no auth). Richest free source — full JD +
 * structured fields. Verified live:
 *   GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 */

interface GhJob {
  id: number;
  internal_job_id?: number;
  title: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string; // HTML, only with ?content=true
  company_name?: string;
  metadata?: unknown;
}
interface GhResponse {
  jobs: GhJob[];
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly source = "greenhouse" as const;
  readonly tier = "tier1" as const;

  /** per-job endpoint: 404 "Job not found" once the req is closed (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.slug) return null;
    return liveFromStatus(await httpStatus(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.slug)}/jobs/${encodeURIComponent(job.jobId)}`));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    const data = await httpJson<GhResponse>(url);
    if (!data?.jobs) return [];

    const jobs = target.limit ? data.jobs.slice(0, target.limit) : data.jobs;
    return jobs.map((j) => {
      const jdText = htmlToText(j.content);
      return {
        source: "greenhouse",
        tier: "tier1",
        atsType: "greenhouse",
        atsJobId: String(j.id),
        companyName: j.company_name ?? slug,
        companySlug: slug,
        title: j.title,
        jdText,
        jdHtml: j.content ?? null,
        locationRaw: j.location?.name ?? null,
        applyUrl: j.absolute_url ?? null,
        salaryRaw: null,
        // updated_at is bulk-bumped on board edits (every Stripe req shared one timestamp),
        // which faked recency — only first_published is a publish date (§3).
        postedAt: j.first_published ?? null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
