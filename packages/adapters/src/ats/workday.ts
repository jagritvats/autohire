import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget } from "../types.js";

/**
 * Workday CXS (Tier 2: the public JSON the careers site itself calls, no auth). The
 * backend of most large employers with India engineering centres (Nvidia, Salesforce,
 * Adobe, PayPal, Target…). One generic adapter; the slug encodes the tenant:
 *   slug = "{host}/{tenant}/{site}", e.g. "nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite"
 * Verified live 2026-09:
 *   POST https://{host}/wday/cxs/{tenant}/{site}/jobs   {appliedFacets, limit≤20, offset, searchText}
 *   GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath}   (JD + startDate)
 * `searchText` is fuzzy ("India" matches Indiana), so the country is applied through the
 * tenant's own location facet — whose name varies by tenant — found by descriptor.
 */

interface WdFacetValue {
  descriptor?: string;
  id?: string;
  count?: number;
  facetParameter?: string;
  values?: WdFacetValue[];
}
interface WdFacet {
  facetParameter: string;
  values?: WdFacetValue[];
}
interface WdJob {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}
interface WdList {
  total?: number;
  jobPostings?: WdJob[];
  facets?: WdFacet[];
}
interface WdDetail {
  jobPostingInfo?: {
    jobDescription?: string;
    startDate?: string;
    location?: string;
    additionalLocations?: string[];
    country?: { descriptor?: string };
    externalUrl?: string;
    remoteType?: string;
  };
}

const PAGE = 20;
const MAX_LIST = 400;

export function parseWorkdaySlug(slug: string): { host: string; tenant: string; site: string } | null {
  const [host, tenant, site] = slug.split("/");
  return host && tenant && site ? { host, tenant, site } : null;
}

export class WorkdayAdapter implements SourceAdapter {
  readonly source = "workday" as const;
  readonly tier = "tier2" as const;

  /**
   * The CXS detail call for the posting's own path (taken from its apply URL): 404
   * "not found: Job_Posting_Anchor_ID" once the req is removed (verified 2026-09).
   */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const t = job.slug ? parseWorkdaySlug(job.slug) : null;
    const path = job.applyUrl?.match(/(\/job\/[^?#]+)/)?.[1];
    if (!t || !path) return null;
    return liveFromStatus(await httpStatus(`https://${t.host}/wday/cxs/${t.tenant}/${t.site}${path}`));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const t = target.slug ? parseWorkdaySlug(target.slug) : null;
    if (!t) return [];
    const api = `https://${t.host}/wday/cxs/${t.tenant}/${t.site}`;
    const post = (body: object) =>
      httpJson<WdList>(`${api}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: PAGE, searchText: "", ...body }),
        timeoutMs: 25_000,
      });

    let appliedFacets: Record<string, string[]> = {};
    const countryName = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;
    if (countryName) {
      const first = await post({ appliedFacets: {}, offset: 0 });
      const facet = findCountryFacet(first?.facets ?? [], countryName);
      // some tenants (Comcast) have no country facet, only sites named "India - Chennai, …"
      const sites = facet ? null : findCountrySites(first?.facets ?? [], countryName);
      if (!facet && !sites) return []; // no roles in that country (or facet missing) — nothing to poll
      appliedFacets = facet ? { [facet.param]: [facet.id] } : { [sites!.param]: sites!.ids };
    }

    const jobs: WdJob[] = [];
    let total = Infinity; // Workday reports `total` on the first page only (later pages say 0)
    for (let offset = 0; offset < Math.min(MAX_LIST, total); offset += PAGE) {
      const page = await post({ appliedFacets, offset });
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!page) return [];
      const batch = page?.jobPostings ?? [];
      if (offset === 0) total = page?.total ?? 0;
      jobs.push(...batch);
      if (batch.length < PAGE) break;
    }

    const idOf = (j: WdJob) => j.externalPath.match(/_([A-Za-z0-9-]+)$/)?.[1] ?? j.externalPath;
    const needDetail = pickForDetail(jobs.filter((j) => !target.known?.has(idOf(j))), (j) => j.title, target.limit ?? DETAIL_CAP);
    const details = new Map<string, WdDetail | null>();
    await mapPool(needDetail, 3, async (j) => details.set(j.externalPath, await httpJson<WdDetail>(`${api}${j.externalPath}`)));

    return jobs.map((j) => {
      const info = details.get(j.externalPath)?.jobPostingInfo;
      const locs = [info?.location ?? j.locationsText, ...(info?.additionalLocations ?? [])].filter(Boolean);
      const remote = /remote/i.test(info?.remoteType ?? "") || /\bremote\b/i.test(locs.join(" "));
      return {
        source: "workday",
        tier: "tier2",
        atsType: "workday",
        atsJobId: idOf(j),
        companyName: t.tenant,
        companySlug: target.slug!,
        title: j.title,
        jdText: htmlToText(info?.jobDescription),
        jdHtml: info?.jobDescription ?? null,
        // Workday location strings are often "IND - Bangalore" — append the country name
        locationRaw: `${remote ? "Remote - " : ""}${locs.join("; ")}${countryName ? `, ${countryName}` : ""}`,
        applyUrl: info?.externalUrl ?? `https://${t.host}/${t.site}${j.externalPath}`,
        salaryRaw: null,
        postedAt: info?.startDate ?? relativePosted(j.postedOn),
        fetchedAt: new Date(),
        raw: j as unknown as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}

/** Walk (possibly nested) facets for a value whose descriptor is exactly the country. */
export function findCountryFacet(facets: WdFacet[], country: string): { param: string; id: string } | null {
  const want = country.toLowerCase();
  const walk = (param: string, values: WdFacetValue[] | undefined): { param: string; id: string } | null => {
    for (const v of values ?? []) {
      if (v.values) {
        const hit = walk(v.facetParameter ?? param, v.values);
        if (hit) return hit;
      } else if (v.id && v.descriptor?.trim().toLowerCase() === want) {
        return { param, id: v.id };
      }
    }
    return null;
  };
  for (const f of facets) {
    const hit = walk(f.facetParameter, f.values);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fallback for tenants without a country facet: every location value NAMED for the
 * country — "India - Chennai, …", "India – Virtual – Karnataka", "Pune, India" — under
 * one facet. Anchored on separators so "IN - Indianapolis" / "Indiana" never match.
 */
export function findCountrySites(facets: WdFacet[], country: string): { param: string; ids: string[] } | null {
  const c = country.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`^${c}\\s*[-–—,:]|[-–—,]\\s*${c}\\s*$`, "i");
  const hits = new Map<string, string[]>();
  const walk = (param: string, values: WdFacetValue[] | undefined) => {
    for (const v of values ?? []) {
      if (v.values) walk(v.facetParameter ?? param, v.values);
      else if (v.id && named.test(v.descriptor?.trim() ?? "")) hits.set(param, [...(hits.get(param) ?? []), v.id]);
    }
  };
  for (const f of facets) walk(f.facetParameter, f.values);
  const best = [...hits.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return best ? { param: best[0], ids: best[1] } : null;
}

/** "Posted Today" / "Posted Yesterday" / "Posted 14 Days Ago" / "Posted 30+ Days Ago" → ISO. */
export function relativePosted(text: string | undefined, now = Date.now()): string | null {
  if (!text) return null;
  const s = text.toLowerCase();
  const days = /today/.test(s) ? 0 : /yesterday/.test(s) ? 1 : Number(s.match(/(\d+)\+?\s*days?/)?.[1] ?? NaN);
  if (!Number.isFinite(days)) return null;
  return new Date(now - days * 86_400_000).toISOString();
}
