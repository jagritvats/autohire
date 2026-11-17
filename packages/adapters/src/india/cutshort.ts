import type { RawPosting, SearchQuery } from "@jobflow/core";
import { htmlToText, httpStatus, liveFromStatus, type FetchTarget, type SourceAdapter, type LivenessTarget, type SearchCaps, type SearchTargetContext } from "../types.js";
import { crossCapped, inIndia, queryTerms, slugifyTerm } from "../search.js";

/**
 * Cutshort (Tier 2: public, server-rendered, no login) — Indian startup/product-company
 * board with structured experience ranges, exact post dates, and a flag for recruiters
 * hiring for a client. Verified live 2026-09: listing pages embed `__NEXT_DATA__` with
 * 50 jobs per page (`?page=N`), e.g.
 *   GET https://cutshort.io/jobs/backend-developer-jobs-in-bangalore-bengaluru
 * `target.query` is the listing slug (role × city), which is how the site scopes searches.
 */

interface CsJob {
  _id: string;
  publicUrl?: string;
  headline: string;
  hiringForClient?: boolean;
  allSkills?: string[];
  salaryRange?: { currency?: string; min?: number; max?: number; hideSalary?: boolean };
  companyDetails?: { name?: string };
  expRange?: { min?: number; max?: number };
  sanitizedComment?: string;
  remoteType?: string;
  jobFactSummary?: { postedDate?: string };
  locationsText?: string;
}

/** city name → Cutshort listing slug (verified live 2026-09). */
export const CUTSHORT_CITY_SLUGS: Readonly<Record<string, string>> = {
  bengaluru: "bangalore-bengaluru",
  bangalore: "bangalore-bengaluru",
  pune: "pune",
  hyderabad: "hyderabad",
};

export class CutshortAdapter implements SourceAdapter {
  readonly source = "cutshort" as const;
  readonly tier = "tier2" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: true, country: false, remote: false, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /**
   * Listing slugs are `{role}-jobs-in-{city}`; only city slugs verified live are used
   * (an unknown city slug is a 404). India only; no named city → the verified hubs.
   */
  toTargets(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[] {
    if (!inIndia(q, ctx)) return [];
    const roles = queryTerms(q).map(slugifyTerm).filter(Boolean);
    if (!roles.length) return [];
    const named = q.locations
      .map((l) => CUTSHORT_CITY_SLUGS[(l.city ?? "").trim().toLowerCase()])
      .filter((s): s is string => !!s);
    if (q.locations.some((l) => l.city) && !named.length) return []; // cities we have no slug for
    const cities = named.length ? [...new Set(named)] : [...new Set(Object.values(CUTSHORT_CITY_SLUGS))];
    return crossCapped(roles, cities).map(([role, city]) => ({ query: `${role}-jobs-in-${city}`, limit: 50 }));
  }

  /** the public job page: 404 once removed (verified 2026-09) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!job.applyUrl?.startsWith("https://cutshort.io/")) return null;
    return liveFromStatus(await httpStatus(job.applyUrl, { headers: { Accept: "text/html" } }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = (target.query ?? "backend-developer-jobs-in-bangalore-bengaluru").replace(/[^a-z0-9-]/gi, "");
    const limit = target.limit ?? 50;
    const out: RawPosting[] = [];
    for (let page = 1; out.length < limit && page <= 5; page++) {
      const html = await fetchPage(`https://cutshort.io/jobs/${slug}${page > 1 ? `?page=${page}` : ""}`);
      const jobs = html ? parseCutshortPage(html) : [];
      if (!jobs.length) break;
      for (const j of jobs) out.push(toRaw(j));
      if (jobs.length < 50) break;
    }
    return out.slice(0, limit);
  }
}

async function fetchPage(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobFlow/0.1; +personal job-search)", Accept: "text/html" },
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the job list out of the page's `__NEXT_DATA__` (react-query dehydrated state). */
export function parseCutshortPage(html: string): CsJob[] {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return [];
  try {
    const data = JSON.parse(m[1]);
    const queries: Array<{ state?: { data?: { data?: { pageData?: { jobs?: CsJob[] } } } } }> =
      data?.props?.pageProps?.dehydratedState?.queries ?? [];
    for (const q of queries) {
      const jobs = q.state?.data?.data?.pageData?.jobs;
      if (Array.isArray(jobs)) return jobs;
    }
  } catch {
    // markup changed — recoverable, the adapter returns []
  }
  return [];
}

function toRaw(j: CsJob): RawPosting {
  const exp = j.expRange?.min != null ? `Experience: ${j.expRange.min}-${j.expRange.max ?? j.expRange.min} years\n` : "";
  // a recruiter posting for an unnamed client: say so in words the trust scorer reads
  const agency = j.hiringForClient ? "Hiring on behalf of a client (third-party recruiter).\n" : "";
  const skills = j.allSkills?.length ? `\nSkills: ${j.allSkills.join(", ")}` : "";
  const s = j.salaryRange;
  const salaryRaw =
    s && !s.hideSalary && s.max && (s.currency ?? "INR") === "INR" ? `₹${Math.round((s.min ?? 0) / 1e5)}-${Math.round(s.max / 1e5)} LPA` : null;
  const remote = j.remoteType && j.remoteType !== "remote_not_okay";
  const where = j.locationsText ?? "";
  return {
    source: "cutshort",
    tier: "tier2",
    atsType: "unknown",
    atsJobId: j._id,
    companyName: j.companyDetails?.name ?? "Unknown",
    companySlug: null,
    title: j.headline,
    jdText: `${agency}${exp}${htmlToText(j.sanitizedComment)}${skills}`,
    jdHtml: j.sanitizedComment ?? null,
    locationRaw: `${remote ? "Remote - India" : ""}${remote && where ? "; " : ""}${where}${where && !/india/i.test(where) ? ", India" : ""}` || "India",
    applyUrl: j.publicUrl ?? null,
    salaryRaw,
    postedAt: j.jobFactSummary?.postedDate ?? null,
    experienceHint: j.expRange?.min != null ? { min: j.expRange.min, max: j.expRange.max ?? null } : undefined,
    fetchedAt: new Date(),
    raw: { id: j._id, hiringForClient: !!j.hiringForClient } as Record<string, unknown>,
  };
}
