import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, httpText, mapPool, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Instahyre (Tier 2: the public JSON its search page calls, no login to browse) —
 * India product-company roles (Meesho, Rippling, Toddle, Amazon…), filterable by years.
 * Verified live 2026-09:
 *   GET https://www.instahyre.com/api/v1/job_search?job_type=1&job_functions=10&years=2&search=true&offset=N  (35/page)
 *   GET https://www.instahyre.com/api/v1/employer_public_jobs/{id}   (JD, workex_min/max, is_active)
 *   GET {public_url}   → JSON-LD "datePosted" (the ORIGINAL date — not refreshed)
 * The list has no date and isn't sorted by recency, but ids rise with time, so the
 * newest `limit` ids get the detail + date calls. A third of the list is >90 days old;
 * those surface with their real age. Applying needs an Instahyre login.
 */

interface IhListItem {
  id: number;
  title: string;
  locations?: string;
  keywords?: string[];
  public_url?: string;
  employer?: { company_name?: string };
}
interface IhList {
  objects?: IhListItem[];
  meta?: { total_count?: number };
}
interface IhDetail {
  is_active?: boolean;
  description?: string;
  workex_min?: number | null;
  workex_max?: number | null;
  locations?: string[];
  hiring_company_name?: string;
}

const PAGE = 35;

export class InstahyreAdapter implements SourceAdapter {
  readonly source = "instahyre" as const;
  readonly tier = "tier2" as const;

  /** the public job JSON: 404 once removed, or `is_active: false` while still served (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const r = await httpStatus(`https://www.instahyre.com/api/v1/employer_public_jobs/${encodeURIComponent(job.jobId)}`);
    if (r?.status !== 200) return liveFromStatus(r);
    try {
      return (JSON.parse(r.body) as { is_active?: boolean }).is_active !== false;
    } catch {
      return null;
    }
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const limit = target.limit ?? 40;
    const qs = new URLSearchParams({
      job_type: "1",
      job_functions: String(target.params?.jobFunction ?? "10"), // 10 = Backend Development
      search: "true",
    });
    if (target.params?.years != null) qs.set("years", String(target.params.years));
    if (target.query) qs.set("skills", target.query);

    const items: IhListItem[] = [];
    for (let offset = 0; offset < 20 * PAGE; offset += PAGE) {
      qs.set("offset", String(offset));
      const res = await httpJson<IhList>(`https://www.instahyre.com/api/v1/job_search?${qs}`);
      const batch = res?.objects ?? [];
      items.push(...batch);
      if (batch.length < PAGE || items.length >= (res?.meta?.total_count ?? 0)) break;
    }
    const newest = [...new Map(items.map((i) => [i.id, i])).values()].sort((a, b) => b.id - a.id).slice(0, limit);

    const enriched = await mapPool(newest, 3, async (i) => {
      const detail = await httpJson<IhDetail>(`https://www.instahyre.com/api/v1/employer_public_jobs/${i.id}`);
      const page = i.public_url ? await httpText(i.public_url) : null;
      const datePosted = page?.match(/"datePosted"\s*:\s*"([^"]+)"/)?.[1] ?? null;
      return { i, detail, datePosted };
    });

    return enriched
      .filter(({ detail }) => detail?.is_active !== false)
      .map(({ i, detail, datePosted }) => {
        const lo = detail?.workex_min;
        const hi = detail?.workex_max;
        const exp = lo != null ? `Experience: ${lo}${hi != null && hi > lo ? `-${hi}` : "+"} years\n` : "";
        const skills = i.keywords?.length ? `\nSkills: ${i.keywords.join(", ")}` : "";
        const locs = detail?.locations?.length ? detail.locations : (i.locations ?? "").split(/,\s*/).filter(Boolean);
        const remote = locs.some((l) => /work from home|remote/i.test(l));
        return {
          source: "instahyre",
          tier: "tier2",
          atsType: "unknown",
          atsJobId: String(i.id),
          companyName: (detail?.hiring_company_name ?? i.employer?.company_name ?? "Unknown").trim(),
          companySlug: null,
          title: i.title.trim(),
          jdText: `${exp}${htmlToText(detail?.description)}${skills}`,
          jdHtml: detail?.description ?? null,
          locationRaw: `${remote ? "Remote - India; " : ""}${locs.filter((l) => !/work from home/i.test(l)).join("; ")}${locs.length ? ", India" : "India"}`,
          applyUrl: i.public_url ?? `https://www.instahyre.com/job-${i.id}/`,
          salaryRaw: null,
          postedAt: datePosted,
          experienceHint: lo != null ? { min: lo, max: hi != null && hi >= lo ? hi : null } : undefined,
          fetchedAt: new Date(),
          raw: { id: i.id } as Record<string, unknown>,
        } satisfies RawPosting;
      });
  }
}
