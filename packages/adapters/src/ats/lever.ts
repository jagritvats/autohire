import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Lever postings API (Tier 1, free, no auth). Verified live:
 *   GET https://api.lever.co/v0/postings/{slug}?mode=json
 * Slugs are case-sensitive lowercase.
 */

interface LeverJob {
  id: string;
  text: string; // title
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  categories?: { commitment?: string; location?: string; team?: string };
  salaryDescriptionPlain?: string;
}

export class LeverAdapter implements SourceAdapter {
  readonly source = "lever" as const;
  readonly tier = "tier1" as const;

  /** per-job endpoint: 404 "Document not found" once the posting is removed (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.slug) return null;
    return liveFromStatus(await httpStatus(`https://api.lever.co/v0/postings/${encodeURIComponent(job.slug)}/${encodeURIComponent(job.jobId)}`));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug?.toLowerCase();
    if (!slug) return [];
    const limit = target.limit ?? 200;
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=${limit}`;
    const data = await httpJson<LeverJob[]>(url);
    if (!Array.isArray(data)) return [];

    return data.map((j) => {
      const jdText = [j.descriptionPlain, j.additionalPlain]
        .filter(Boolean)
        .join("\n\n")
        .trim() || htmlToText(j.description);
      return {
        source: "lever",
        tier: "tier1",
        atsType: "lever",
        atsJobId: j.id,
        companyName: slug,
        companySlug: slug,
        title: j.text,
        jdText,
        jdHtml: j.description ?? null,
        locationRaw: j.categories?.location ?? null,
        applyUrl: j.applyUrl ?? j.hostedUrl ?? null,
        salaryRaw: j.salaryDescriptionPlain ?? null,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
