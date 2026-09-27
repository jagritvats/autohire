import type { RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, DETAIL_CAP, pickForDetail, htmlToText, httpJson, mapPool, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Oracle HCM Cloud "Candidate Experience" (Tier 2: the public REST the careers site
 * calls, no auth) — JPMorgan, Goldman Sachs, Icertis and other large India employers.
 * slug = "{host}/{siteNumber}", e.g. "jpmc.fa.oraclecloud.com/CX_1001". Verified 2026-09:
 *   GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *       ?onlyData=true&expand=requisitionList.secondaryLocations
 *       &finder=findReqs;siteNumber={CX},limit=200,offset=N,location=India,sortBy=POSTING_DATES_DESC
 *   GET …/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id="{Id}",siteNumber={CX}
 * Traps: an unknown siteNumber (or an alias) silently returns EVERY job in the tenant,
 * so seeds carry the CX_ number; page size is capped at 200; ignore `hasMore` (always
 * false) and page by TotalJobsCount. `PostedDate` is the CURRENT posting's start, which
 * reposts reset — not the original publish date.
 */

interface OrcReq {
  Id: string;
  Title: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  WorkplaceTypeCode?: string | null;
  secondaryLocations?: Array<{ Name?: string; CountryCode?: string }>;
}
interface OrcList {
  items?: Array<{ TotalJobsCount?: number; requisitionList?: OrcReq[] }>;
}
interface OrcDetail {
  items?: Array<{
    ExternalDescriptionStr?: string;
    ExternalResponsibilitiesStr?: string;
    ExternalQualificationsStr?: string;
  }>;
}

const PAGE = 200;
const MAX_LIST = 1000;
/** tenants whose own careers site is the better apply link than the generic CE page */
const APPLY_OVERRIDES: Record<string, (id: string) => string> = {
  "hdpc.fa.us2.oraclecloud.com": (id) => `https://higher.gs.com/roles/${id}`,
};

export class OracleHcmAdapter implements SourceAdapter {
  readonly source = "oracle" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const [host, site] = (target.slug ?? "").split("/");
    if (!host || !site || !/^CX(_\d+)?$/.test(site)) return []; // bare "CX" is valid (Texas Instruments)
    const api = `https://${host}/hcmRestApi/resources/latest`;
    const country = target.location ? COUNTRY_NAMES[target.location.toUpperCase()] ?? target.location : null;

    const reqs: OrcReq[] = [];
    let total = Infinity;
    for (let offset = 0; offset < Math.min(total, MAX_LIST); offset += PAGE) {
      const finder = [`findReqs;siteNumber=${site}`, `limit=${PAGE}`, `offset=${offset}`, country ? `location=${country}` : "", "sortBy=POSTING_DATES_DESC"]
        .filter(Boolean)
        .join(",");
      const res = await httpJson<OrcList>(
        `${api}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`,
        { timeoutMs: 30_000 },
      );
      if (!res) return []; // all-or-nothing (markStale)
      const item = res.items?.[0];
      total = item?.TotalJobsCount ?? 0;
      const batch = item?.requisitionList ?? [];
      reqs.push(...batch);
      if (batch.length === 0) break;
    }

    const needDetail = pickForDetail(reqs.filter((r) => !target.known?.has(r.Id)), (r) => r.Title, target.limit ?? DETAIL_CAP);
    const details = new Map<string, string>();
    await mapPool(needDetail, 3, async (r) => {
      const d = await httpJson<OrcDetail>(
        `${api}/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${encodeURIComponent(`ById;Id="${r.Id}",siteNumber=${site}`)}`,
        { timeoutMs: 30_000 },
      );
      const i = d?.items?.[0];
      if (i) {
        details.set(r.Id, [i.ExternalDescriptionStr, i.ExternalResponsibilitiesStr, i.ExternalQualificationsStr].map((x) => htmlToText(x)).filter(Boolean).join("\n\n"));
      }
    });

    return reqs.map((r) => {
      const locs = [r.PrimaryLocation, ...(r.secondaryLocations ?? []).map((l) => l.Name)].filter(Boolean);
      const mode = /remote/i.test(r.WorkplaceTypeCode ?? "") ? "Remote - " : /hybrid/i.test(r.WorkplaceTypeCode ?? "") ? "Hybrid - " : "";
      return {
        source: "oracle",
        tier: "tier2",
        atsType: "oracle",
        atsJobId: r.Id,
        companyName: host.split(".")[0] ?? host,
        companySlug: target.slug!,
        title: r.Title,
        jdText: details.get(r.Id) ?? "",
        jdHtml: null,
        locationRaw: `${mode}${[...new Set(locs)].join("; ")}` || null,
        applyUrl: APPLY_OVERRIDES[host]?.(r.Id) ?? `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        salaryRaw: null,
        postedAt: r.PostedDate ?? null,
        fetchedAt: new Date(),
        raw: { Id: r.Id } as Record<string, unknown>,
      } satisfies RawPosting;
    });
  }
}
