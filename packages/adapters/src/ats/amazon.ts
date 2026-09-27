import type { RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Amazon Jobs (Tier 2: the public JSON amazon.jobs' own search calls, no auth). One
 * of the largest engineering employers in India (Bengaluru, Hyderabad, Chennai…).
 * Verified live 2026-09 (≈1.1k India "software" hits):
 *   GET https://www.amazon.jobs/en/search.json?base_query=…&country=IND&result_limit=100&offset=N&sort=recent
 * Full description + qualifications come in the list, and `posted_date` is exact.
 * slug = the search keyword set to cover ("software"); country comes from the poll.
 */

interface AmzJob {
  id_icims: string;
  title: string;
  company_name?: string;
  location?: string;
  normalized_location?: string;
  city?: string;
  country_code?: string;
  posted_date?: string;
  job_path?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
  is_intern?: boolean | null;
}
interface AmzResponse {
  hits?: number;
  jobs?: AmzJob[];
}

const ISO3: Record<string, string> = { IN: "IND", US: "USA", GB: "GBR", DE: "DEU", SG: "SGP", CA: "CAN" };
const PAGE = 100;
/** track the most recent N (sorted by recency) — older reqs age out of the window, which
 *  markStale treats as closed; at Amazon's volume anything older is rarely still live. */
const MAX_LIST = 500;

export class AmazonJobsAdapter implements SourceAdapter {
  readonly source = "amazon" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const query = target.slug && target.slug !== "amazon" ? target.slug : "software";
    const country = target.location ? ISO3[target.location.toUpperCase()] ?? target.location : null;
    const out: RawPosting[] = [];
    for (let offset = 0; offset < MAX_LIST; offset += PAGE) {
      const qs = new URLSearchParams({ base_query: query, result_limit: String(PAGE), offset: String(offset), sort: "recent" });
      if (country) qs.set("country", country);
      const res = await httpJson<AmzResponse>(`https://www.amazon.jobs/en/search.json?${qs}`, { timeoutMs: 30_000 });
      // a failed page mid-list would make the tail look closed to markStale — all or nothing
      if (!res) return [];
      const jobs = res?.jobs ?? [];
      for (const j of jobs) out.push(toRaw(j));
      if (jobs.length < PAGE || out.length >= (res?.hits ?? 0)) break;
    }
    return out;
  }
}

function toRaw(j: AmzJob): RawPosting {
  const jd = [
    htmlToText(j.description),
    j.basic_qualifications ? `Basic qualifications:\n${htmlToText(j.basic_qualifications)}` : "",
    j.preferred_qualifications ? `Preferred qualifications:\n${htmlToText(j.preferred_qualifications)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const posted = j.posted_date ? new Date(j.posted_date) : null;
  return {
    source: "amazon",
    tier: "tier2",
    atsType: "amazon",
    atsJobId: j.id_icims,
    companyName: j.company_name ?? "Amazon",
    companySlug: "amazon",
    title: j.is_intern ? `${j.title} (Intern)` : j.title,
    jdText: jd,
    jdHtml: j.description ?? null,
    // "IN, KA, Bengaluru" → spell out the country so the location parser resolves it
    locationRaw: [j.normalized_location ?? j.location, j.country_code === "IND" ? "India" : null].filter(Boolean).join(", ") || null,
    applyUrl: j.job_path ? `https://www.amazon.jobs${j.job_path}` : null,
    salaryRaw: null,
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    fetchedAt: new Date(),
    raw: { id: j.id_icims, job_path: j.job_path } as Record<string, unknown>,
  };
}
