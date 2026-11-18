import type { LevelBand, RawPosting } from "@jobflow/core";
import { DETAIL_CAP, markPartial, pickForDetail, htmlToText, httpJson, mapPool, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * SmartRecruiters public posting API (Tier 1, free, no auth). Used by Freshworks,
 * Bosch, Visa-style large employers with big India offices. Verified live 2026-09:
 *   GET https://api.smartrecruiters.com/v1/companies/{id}/postings?country=in&limit=100&offset=N
 *   GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}   (JD sections)
 * The list carries releasedDate + experienceLevel + structured location; the JD needs
 * the detail call, so only NEW postings get one (see FetchTarget.known).
 */

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  experienceLevel?: { id?: string; label?: string };
  company?: { identifier?: string; name?: string };
}
interface SrList {
  totalFound?: number;
  content?: SrPosting[];
}
interface SrDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

const MAX_LIST = 600;

export class SmartRecruitersAdapter implements SourceAdapter {
  readonly source = "smartrecruiters" as const;
  readonly tier = "tier1" as const;

  /** per-job endpoint: 404 RESOURCE_NOT_FOUND once the posting is removed (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.slug) return null;
    return liveFromStatus(await httpStatus(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.slug)}/postings/${encodeURIComponent(job.jobId)}`));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`;
    const country = target.location?.toLowerCase();

    const listed: SrPosting[] = [];
    let total = 0;
    for (let offset = 0; offset < MAX_LIST; offset += 100) {
      const qs = new URLSearchParams({ limit: "100", offset: String(offset) });
      if (country) qs.set("country", country);
      const page = await httpJson<SrList>(`${base}?${qs}`);
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!page) return [];
      const content = page?.content ?? [];
      listed.push(...content);
      total = page?.totalFound ?? listed.length;
      if (content.length < 100 || listed.length >= total) break;
    }
    // a posting released mid-poll shifts the pages, so a row can repeat
    const list = [...new Map(listed.map((p) => [p.id, p])).values()];
    // cut at MAX_LIST with more on the board: never a markStale diff (invariant #5)
    const truncated = listed.length < total;

    // newest first, so the detail budget goes to fresh roles
    list.sort((a, b) => (b.releasedDate ?? "").localeCompare(a.releasedDate ?? ""));
    const needDetail = pickForDetail(list.filter((p) => !target.known?.has(p.id)), (p) => p.name, target.limit ?? DETAIL_CAP);
    const details = new Map<string, SrDetail | null>();
    await mapPool(needDetail, 4, async (p) => details.set(p.id, await httpJson<SrDetail>(`${base}/${p.id}`)));

    const out = list.map((p) => {
      const d = details.get(p.id);
      const loc = p.location;
      const place = loc?.fullLocation ?? [loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ");
      const sections = Object.values(d?.jobAd?.sections ?? {})
        .map((s) => [s.title, htmlToText(s.text)].filter(Boolean).join("\n"))
        .join("\n\n");
      return {
        source: "smartrecruiters",
        tier: "tier1",
        atsType: "smartrecruiters",
        atsJobId: p.id,
        companyName: p.company?.name ?? slug,
        companySlug: slug,
        title: p.name,
        jdText: sections ? `${p.experienceLevel?.label ? `Experience level: ${p.experienceLevel.label}\n` : ""}${sections}` : "",
        jdHtml: null,
        locationRaw: loc?.remote ? `Remote - ${place}` : loc?.hybrid ? `Hybrid - ${place}` : place || null,
        applyUrl: d?.applyUrl ?? d?.postingUrl ?? `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
        salaryRaw: null,
        postedAt: p.releasedDate ?? null,
        levelHint: SR_LEVELS[p.experienceLevel?.id ?? ""] ?? null,
        fetchedAt: new Date(),
        raw: p as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
    return truncated ? markPartial(out) : out;
  }
}

/** SmartRecruiters experience buckets. "mid_senior_level" spans mid→senior, so no hint. */
const SR_LEVELS: Record<string, LevelBand> = {
  internship: "intern",
  entry_level: "junior",
  associate: "junior",
  director: "director",
  executive: "director",
};
