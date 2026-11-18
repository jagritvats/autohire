import type { LevelBand, RawPosting, SearchQuery } from "@jobflow/core";
import { htmlToText, httpJson, httpStatus, type FetchTarget, type LivenessTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { crossCapped, queryCountries, queryTerms } from "../search.js";

/**
 * Jobicy (Tier 1: the public remote-jobs API, no key). Remote-only board. Verified live
 * 2026-11 (docs: jobicy.com/jobs-rss-feed):
 *   GET https://jobicy.com/api/jobs?count=1..100&geo=…&industry=…&tag=…&cursor=…
 *       → { jobs[], nextCursor, hasMore } — only jobs published in the last 7 days
 *   GET https://jobicy.com/api/jobs/status?ids=1,2,…  → each id "active" | "closed" | "unknown"
 * TERMS: credit Jobicy and link to the source; apply buttons must go to the Jobicy job
 * URL in the feed (so `applyUrl` is that URL); no more than one automated pass an hour.
 * Leaving the 7-day window does NOT mean a job closed — only the status endpoint's
 * explicit "closed" does (isLive). Its dates are Jobicy's (REDATED_SOURCES).
 *
 * The hourly limit is enforced HERE, not left to whoever schedules the feed: a target
 * fetched less than MIN_INTERVAL_MS ago answers [] without a request (per process, keyed
 * by target, like JSearch's spend guard). A request-bound refresh, a second preset or a
 * saved search can't make it poll faster. [] reads as "unknown" to ingest, and feed rows
 * only expire through the lastSeen TTL sweep, so a skipped pass loses nothing.
 */

export interface JobicyJob {
  id: number | string;
  url?: string;
  jobSlug?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: string[] | string;
  jobType?: string[] | string;
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
}
interface JobicyResponse {
  jobs?: JobicyJob[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

/** ISO-2 → Jobicy geo slug (from ?get=locations, 2026-11). No India slug: worldwide roles. */
const JOBICY_GEO: Record<string, string> = {
  US: "usa",
  GB: "uk",
  CA: "canada",
  DE: "germany",
  NL: "netherlands",
  FR: "france",
  ES: "spain",
  IE: "ireland",
  PL: "poland",
  PT: "portugal",
  SE: "sweden",
  AU: "australia",
  SG: "singapore",
  AE: "united-arab-emirates",
  IN: "anywhere",
};

const PAGE_MAX = 100;
const MAX_PAGES = 3;
/** Jobicy's terms: no more than one automated pass an hour. */
export const JOBICY_MIN_INTERVAL_MS = 60 * 60_000;
/** last pass per target, process-wide (adapter instances may be re-created). */
const lastPass = new Map<string, number>();

/** test hook: forget the hourly pacing. */
export function resetJobicyPacing(): void {
  lastPass.clear();
}

export class JobicyAdapter implements SourceAdapter {
  readonly source = "jobicy" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: true, remote: true, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /** remote-only: one target per (term × country geo). */
  toTargets(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[] {
    if (q.remote === "exclude") return [];
    const terms = queryTerms(q);
    if (!terms.length) return [];
    const geos = [...new Set(queryCountries(q, ctx).map((c) => JOBICY_GEO[c] ?? "anywhere"))];
    return crossCapped(terms, geos.length ? geos : [""]).map(([term, geo]): FetchTarget => (geo ? { query: term, limit: 50, params: { geo } } : { query: term, limit: 50 }));
  }

  /** the batch status endpoint: false only on an explicit "closed" (its own docs' rule). */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    if (!/^\d+$/.test(job.jobId)) return null;
    const r = await httpStatus(`https://jobicy.com/api/jobs/status?ids=${job.jobId}`);
    if (r?.status !== 200) return null;
    try {
      const status = (JSON.parse(r.body) as { jobs?: Array<{ id: number | string; status?: string }> }).jobs?.find((j) => String(j.id) === job.jobId)?.status;
      return status === "closed" ? false : status === "active" ? true : null;
    } catch {
      return null;
    }
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const limit = Math.max(1, target.limit ?? 50);
    const base = new URLSearchParams({ count: String(Math.min(PAGE_MAX, limit)) });
    if (target.query) base.set("tag", target.query);
    for (const k of ["geo", "industry"] as const) {
      const v = target.params?.[k];
      if (typeof v === "string" && /^[a-z-]+$/.test(v)) base.set(k, v);
    }
    const pass = base.toString();
    const prev = lastPass.get(pass);
    if (prev != null && Date.now() - prev < JOBICY_MIN_INTERVAL_MS) return [];
    lastPass.set(pass, Date.now()); // a failed pass counts too: the request was still made

    const jobs: JobicyJob[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES && jobs.length < limit; page++) {
      const qs = new URLSearchParams(base);
      if (cursor) qs.set("cursor", cursor);
      const res: JobicyResponse | null = await httpJson<JobicyResponse>(`https://jobicy.com/api/jobs?${qs}`);
      if (!res || !Array.isArray(res.jobs)) break;
      jobs.push(...res.jobs);
      cursor = res.nextCursor ?? null;
      if (!cursor || !res.hasMore || String(res.hasMore) === "False") break;
    }
    return parseJobicyJobs(jobs).slice(0, limit);
  }
}

/** API rows → RawPostings (pure; exported for fixture tests). */
export function parseJobicyJobs(jobs: JobicyJob[]): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const j of jobs) {
    const id = String(j.id ?? "");
    if (!id || !j.jobTitle?.trim() || !j.companyName?.trim() || seen.has(id)) continue;
    seen.add(id);
    const lo = Number(j.salaryMin);
    const hi = Number(j.salaryMax);
    const pay = j.salaryCurrency && (lo > 0 || hi > 0)
      ? `${j.salaryCurrency} ${[lo, hi].filter((x) => x > 0).join(" - ")}${j.salaryPeriod ? ` per ${PERIOD[j.salaryPeriod] ?? j.salaryPeriod}` : ""}`
      : null;
    const geo = (j.jobGeo ?? "").replace(/\s*,\s*/g, ", ").trim();
    const t = j.pubDate ? Date.parse(j.pubDate) : NaN;
    out.push({
      source: "jobicy",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: id,
      companyName: j.companyName.trim(),
      companySlug: null,
      title: decode(j.jobTitle.trim()),
      jdText: htmlToText(j.jobDescription) || j.jobExcerpt || "",
      jdHtml: j.jobDescription ?? null,
      locationRaw: geo && !/^anywhere$/i.test(geo) ? `Remote - ${geo}` : "Remote - Worldwide",
      // ToS: apply buttons go to the Jobicy job URL from the feed
      applyUrl: j.url ?? (j.jobSlug ? `https://jobicy.com/jobs/${j.jobSlug}` : null),
      salaryRaw: pay,
      postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      levelHint: JOBICY_LEVELS[(j.jobLevel ?? "").toLowerCase()] ?? null,
      fetchedAt: new Date(),
      raw: { id, industry: j.jobIndustry, type: j.jobType, level: j.jobLevel, attribution: "Jobicy" } as Record<string, unknown>,
    });
  }
  return out;
}

const PERIOD: Record<string, string> = { yearly: "year", monthly: "month", weekly: "week", daily: "day", hourly: "hour" };

const JOBICY_LEVELS: Record<string, LevelBand> = {
  junior: "junior",
  midweight: "mid",
  senior: "senior",
  lead: "lead",
  manager: "manager",
  director: "director",
};

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"');
}
