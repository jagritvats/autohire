import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Atlassian careers (Tier 2: the JSON its own careers page loads, no auth) — a large
 * Bengaluru engineering centre. Their ATS is iCIMS (no usable public API), but the
 * site's listing endpoint returns every job with the JD inline. Verified 2026-09:
 *   GET https://www.atlassian.com/endpoint/careers/listings   (~2 MB, no params)
 * Rows repeat per portal — dedupe on id. `portalJobPost.updatedDate` is a refresh time,
 * not a publish date, so no postedAt is claimed (freshness falls back to firstSeen).
 */

interface AtlListing {
  id: number;
  title: string;
  locations?: string[];
  category?: string;
  overview?: string;
  responsibilities?: string;
  qualifications?: string;
  applyUrl?: string;
}

export class AtlassianAdapter implements SourceAdapter {
  readonly source = "atlassian" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const rows = await httpJson<AtlListing[]>("https://www.atlassian.com/endpoint/careers/listings", { timeoutMs: 45_000 });
    if (!Array.isArray(rows)) return [];
    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;
    const countryRe = country ? new RegExp(`\\b${country}\\b`, "i") : null;
    const seen = new Set<number>();
    const out: RawPosting[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const locs = (r.locations ?? []).map((l) => l.replace(/\s+/g, " ").trim());
      if (countryRe && !locs.some((l) => countryRe.test(l))) continue;
      out.push({
        source: "atlassian",
        tier: "tier2",
        atsType: "atlassian",
        atsJobId: String(r.id),
        companyName: "Atlassian",
        companySlug: "atlassian",
        title: r.title,
        jdText: [r.overview, r.responsibilities, r.qualifications].map((x) => htmlToText(x)).filter(Boolean).join("\n\n"),
        jdHtml: null,
        locationRaw: locs.join("; ") || null,
        applyUrl: `https://www.atlassian.com/company/careers/details/${r.id}`,
        salaryRaw: null,
        postedAt: null,
        fetchedAt: new Date(),
        raw: { id: r.id, category: r.category } as Record<string, unknown>,
      });
    }
    return out;
  }
}
