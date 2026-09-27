import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpText, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Keka Hire (Tier 2: the JSON behind {company}.keka.com/careers, no auth) — an Indian
 * HR suite used by many Indian startups (Signzy, Eloelo, Jupiter, ClickPost, Zluri).
 * slug = the subdomain. Verified live 2026-09:
 *   GET https://{c}.keka.com/careers/                     → org GUID in "/ats/documents/{GUID}/"
 *   GET https://{c}.keka.com/careers/api/embedjobs/default/active/{GUID}   → all jobs, JD inline
 * `publishedOn` is a RE-publish date (old ids carry recent dates) — lower-trust recency.
 * `jobLocations` is often empty; Keka tenants are India-based, so an empty list is read
 * as "India" rather than dropped.
 */

interface KekaJob {
  id: number;
  title: string;
  description?: string;
  experience?: string | null;
  jobLocations?: Array<{ city?: string; state?: string; countryCode?: string; countryName?: string }>;
  publishedOn?: string;
  skillNames?: string[];
}

const GUID_RE = [
  /\/ats\/documents\/([0-9a-f-]{36})\//i,
  /identifier:\s*'([0-9a-f-]{36})'/i,
  /embedjobs\/js\/([0-9a-f-]{36})/i,
];

export class KekaAdapter implements SourceAdapter {
  readonly source = "keka" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const sub = target.slug?.replace(/[^a-z0-9-]/gi, "");
    if (!sub) return [];
    const html = await httpText(`https://${sub}.keka.com/careers/`);
    const guid = html ? GUID_RE.map((re) => html.match(re)?.[1]).find(Boolean) : null;
    if (!guid) return [];
    const jobs = await httpJson<KekaJob[]>(`https://${sub}.keka.com/careers/api/embedjobs/default/active/${guid}`);
    if (!Array.isArray(jobs)) return [];

    return jobs.map((j) => {
      const locs = (j.jobLocations ?? []).map((l) => [l.city, l.state, l.countryName ?? l.countryCode].filter(Boolean).join(", "));
      const skills = j.skillNames?.length ? `\nSkills: ${j.skillNames.join(", ")}` : "";
      return {
        source: "keka",
        tier: "tier2",
        atsType: "keka",
        atsJobId: String(j.id),
        companyName: sub,
        companySlug: sub,
        title: j.title.trim(),
        jdText: `${j.experience ? `Experience: ${j.experience}\n` : ""}${htmlToText(j.description)}${skills}`,
        jdHtml: j.description ?? null,
        locationRaw: locs.length ? locs.join("; ") : "India",
        applyUrl: `https://${sub}.keka.com/careers/jobdetails/${j.id}`,
        salaryRaw: null,
        postedAt: j.publishedOn ?? null,
        fetchedAt: new Date(),
        raw: { id: j.id } as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
