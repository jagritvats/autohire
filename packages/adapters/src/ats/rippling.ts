import type { RawPosting } from "@jobflow/core";
import { DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Rippling ATS (Tier 2: public board API, no auth) — Rippling itself plus companies
 * hiring in India on it (Copado, RSA, Pythian, Forbes Advisor, CBTS India…).
 * slug = the board name in ats.rippling.com/{slug}/jobs. Verified live 2026-09:
 *   GET https://api.rippling.com/platform/api/ats/v2/board/{slug}/jobs?country=IN&page=0&pageSize=1000
 *   GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}   (JD + createdOn)
 * The list has no date; `createdOn` from the detail looks like true creation.
 */

interface RpItem {
  id: string;
  name: string;
  url?: string;
  locations?: Array<{ name?: string; countryCode?: string; workplaceType?: string }>;
}
interface RpList {
  items?: RpItem[];
  totalPages?: number;
}
interface RpDetail {
  createdOn?: string;
  companyName?: string;
  description?: { company?: string; role?: string };
}

export class RipplingAdapter implements SourceAdapter {
  readonly source = "rippling" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const base = `https://api.rippling.com/platform/api/ats`;
    const items: RpItem[] = [];
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ page: String(page), pageSize: "1000" });
      if (target.location) qs.set("country", target.location.toUpperCase());
      const res = await httpJson<RpList>(`${base}/v2/board/${encodeURIComponent(slug)}/jobs?${qs}`);
      if (!res) return []; // all-or-nothing (markStale)
      items.push(...(res.items ?? []));
      if (page + 1 >= (res.totalPages ?? 1)) break;
    }

    const needDetail = pickForDetail(items.filter((i) => !target.known?.has(i.id)), (i) => i.name, target.limit ?? DETAIL_CAP);
    const details = new Map<string, RpDetail | null>();
    await mapPool(needDetail, 3, async (i) =>
      details.set(i.id, await httpJson<RpDetail>(`${base}/v1/board/${encodeURIComponent(slug)}/jobs/${i.id}`)),
    );

    return items.map((i) => {
      const d = details.get(i.id);
      const locs = (i.locations ?? []).map((l) => l.name).filter(Boolean);
      const types = (i.locations ?? []).map((l) => l.workplaceType ?? "");
      const mode = types.some((t) => /remote/i.test(t)) ? "Remote - " : types.some((t) => /hybrid/i.test(t)) ? "Hybrid - " : "";
      return {
        source: "rippling",
        tier: "tier2",
        atsType: "rippling",
        atsJobId: i.id,
        companyName: d?.companyName ?? slug,
        companySlug: slug,
        title: i.name.trim(),
        jdText: [htmlToText(d?.description?.role), htmlToText(d?.description?.company)].filter(Boolean).join("\n\n"),
        jdHtml: d?.description?.role ?? null,
        locationRaw: `${mode}${locs.join("; ")}` || null,
        applyUrl: i.url ?? `https://ats.rippling.com/${slug}/jobs/${i.id}`,
        salaryRaw: null,
        postedAt: d?.createdOn ?? null,
        fetchedAt: new Date(),
        raw: { id: i.id } as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
