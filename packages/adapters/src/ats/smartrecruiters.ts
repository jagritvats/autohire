import type { LevelBand, RawPosting } from "@jobflow/core";
import { DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

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

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`;
    const country = target.location?.toLowerCase();

    const list: SrPosting[] = [];
    for (let offset = 0; offset < MAX_LIST; offset += 100) {
      const qs = new URLSearchParams({ limit: "100", offset: String(offset) });
      if (country) qs.set("country", country);
      const page = await httpJson<SrList>(`${base}?${qs}`);
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!page) return [];
      const content = page?.content ?? [];
      list.push(...content);
      if (content.length < 100 || list.length >= (page?.totalFound ?? 0)) break;
    }

    // newest first, so the detail budget goes to fresh roles
    list.sort((a, b) => (b.releasedDate ?? "").localeCompare(a.releasedDate ?? ""));
    const needDetail = pickForDetail(list.filter((p) => !target.known?.has(p.id)), (p) => p.name, target.limit ?? DETAIL_CAP);
    const details = new Map<string, SrDetail | null>();
    await mapPool(needDetail, 4, async (p) => details.set(p.id, await httpJson<SrDetail>(`${base}/${p.id}`)));

    return list.map((p) => {
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
