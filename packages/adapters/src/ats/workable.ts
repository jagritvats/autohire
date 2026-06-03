import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Workable public widget API (Tier 1, free, no auth):
 *   GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
 * Markup/endpoints shift more than Greenhouse/Lever — adapter degrades to [] safely.
 */

interface WkJob {
  shortcode?: string;
  id?: string;
  title: string;
  description?: string;
  full_description?: string;
  location?: { city?: string; country?: string; region?: string };
  telecommuting?: boolean;
  url?: string;
  application_url?: string;
  published_on?: string;
}
interface WkResponse {
  jobs?: WkJob[];
  results?: WkJob[];
}

export class WorkableAdapter implements SourceAdapter {
  readonly source = "workable" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
    const data = await httpJson<WkResponse>(url);
    const jobs = data?.jobs ?? data?.results ?? [];
    if (!jobs.length) return [];

    const sliced = target.limit ? jobs.slice(0, target.limit) : jobs;
    return sliced.map((j) => {
      const loc = j.location;
      const locStr = j.telecommuting
        ? "Remote"
        : [loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ") || null;
      return {
        source: "workable",
        tier: "tier1",
        atsType: "workable",
        atsJobId: j.shortcode ?? j.id ?? String(j.title),
        companyName: slug,
        companySlug: slug,
        title: j.title,
        jdText: htmlToText(j.full_description ?? j.description),
        jdHtml: j.full_description ?? j.description ?? null,
        locationRaw: locStr,
        applyUrl: j.application_url ?? j.url ?? null,
        salaryRaw: null,
        postedAt: j.published_on ?? null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
