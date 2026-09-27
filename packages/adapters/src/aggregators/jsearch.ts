import { classifyLink, type RawPosting } from "@jobflow/core";
import { COUNTRY_NAMES, htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * JSearch (PAID, key-gated, off by default) — the Google-for-Jobs index behind an API, so
 * one call reaches Indian boards + employer career sites at once. Picked over SerpAPI's
 * google_jobs for India coverage per paid request: `num_pages` returns up to 10×10 jobs in
 * one call (SerpAPI: 10), with an absolute posted date, ISO country, a remote flag,
 * annual/monthly pay with currency, and every apply option (often the employer's own ATS).
 * Two ways in (contract from the vendor docs, 2026-09):
 *   OpenWeb Ninja: GET https://api.openwebninja.com/jsearch/search-v2   header x-api-key      (JSEARCH_API_KEY)
 *   RapidAPI:      GET https://jsearch.p.rapidapi.com/search             header X-RapidAPI-Key (JSEARCH_RAPIDAPI_KEY)
 *   ?query="<role> in <place>"&country=in&date_posted=week&num_pages=N
 * No key → [] before any request. Every poll would otherwise spend credits (the worker
 * polls every 6h), so each target is fetched at most once per JSEARCH_MIN_HOURS (default
 * 24) per process. Listings come via Google, never a user session (invariant #1).
 */

export interface JSearchApplyOption {
  publisher?: string;
  apply_link?: string;
  is_direct?: boolean;
}
export interface JSearchJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string;
  job_publisher?: string;
  job_description?: string;
  job_apply_link?: string;
  job_apply_is_direct?: boolean;
  apply_options?: JSearchApplyOption[];
  job_google_link?: string;
  job_is_remote?: boolean | null;
  job_posted_at_timestamp?: number | null;
  job_posted_at_datetime_utc?: string | null;
  job_location?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  /** YEAR | MONTH | WEEK | DAY | HOUR */
  job_salary_period?: string | null;
  job_required_experience?: { required_experience_in_months?: number | null } | null;
  job_highlights?: Record<string, string[]>;
}
/** v1 (/search) returns `data: Job[]`; v2 (/search-v2) returns `data: { jobs, cursor }`. */
export interface JSearchResponse {
  status?: string;
  data?: JSearchJob[] | { jobs?: JSearchJob[]; cursor?: string | null };
}

const PAGE = 10;

export function hasJSearchKey(): boolean {
  return !!(process.env.JSEARCH_API_KEY || process.env.JSEARCH_RAPIDAPI_KEY);
}

function endpoint(): { url: string; headers: Record<string, string>; paged: boolean } | null {
  if (process.env.JSEARCH_API_KEY) {
    return { url: "https://api.openwebninja.com/jsearch/search-v2", headers: { "x-api-key": process.env.JSEARCH_API_KEY }, paged: false };
  }
  if (process.env.JSEARCH_RAPIDAPI_KEY) {
    return {
      url: "https://jsearch.p.rapidapi.com/search",
      headers: { "X-RapidAPI-Key": process.env.JSEARCH_RAPIDAPI_KEY, "X-RapidAPI-Host": "jsearch.p.rapidapi.com" },
      paged: true,
    };
  }
  return null;
}

function minIntervalMs(): number {
  const v = process.env.JSEARCH_MIN_HOURS;
  const h = v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 24;
  return Math.max(0, h) * 3_600_000;
}

export class JSearchAdapter implements SourceAdapter {
  readonly source = "jsearch" as const;
  readonly tier = "tier2" as const;
  /** last spend per target (paid source: bound the calls, not just the results). */
  private readonly lastFetch = new Map<string, number>();

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const ep = endpoint();
    if (!ep) return []; // key-gated: no key, no request
    const key = JSON.stringify([target.query, target.location, target.params, target.limit]);
    const prev = this.lastFetch.get(key);
    if (prev != null && Date.now() - prev < minIntervalMs()) return [];
    this.lastFetch.set(key, Date.now()); // counted even if it fails — a failed call may still bill

    const limit = target.limit ?? 30;
    const role = target.query ?? "backend developer";
    const qs = new URLSearchParams({
      query: target.location ? `${role} in ${target.location}` : role,
      country: String(target.params?.country ?? "in"),
      date_posted: String(target.params?.datePosted ?? "week"),
      num_pages: String(Math.min(10, Math.max(1, Math.ceil(limit / PAGE)))),
    });
    if (ep.paged) qs.set("page", "1");
    if (target.params?.employmentTypes) qs.set("employment_types", String(target.params.employmentTypes));
    if (target.params?.jobRequirements) qs.set("job_requirements", String(target.params.jobRequirements));
    if (target.params?.remoteOnly) qs.set("work_from_home", "true");
    const data = await httpJson<JSearchResponse>(`${ep.url}?${qs}`, { headers: ep.headers, timeoutMs: 45_000 });
    return parseJSearchResponse(data).slice(0, limit);
  }
}

/** Map a JSearch response (v1 or v2 shape) to raw postings (pure; exported for fixture tests). */
export function parseJSearchResponse(data: JSearchResponse | null): RawPosting[] {
  const d = data?.data;
  const jobs = Array.isArray(d) ? d : (d?.jobs ?? []);
  const out: RawPosting[] = [];
  for (const j of jobs) {
    const title = j.job_title?.trim();
    if (!j.job_id || !title) continue;
    const months = j.job_required_experience?.required_experience_in_months;
    out.push({
      source: "jsearch",
      tier: "tier2",
      atsType: "unknown",
      atsJobId: j.job_id,
      companyName: j.employer_name?.trim() || "Unknown",
      companySlug: null,
      title,
      jdText: j.job_description?.trim() || highlightsText(j.job_highlights),
      jdHtml: null,
      locationRaw: jsearchLocation(j),
      applyUrl: pickApplyLink(j),
      salaryRaw: jsearchSalary(j),
      postedAt:
        j.job_posted_at_datetime_utc ?? (j.job_posted_at_timestamp ? new Date(j.job_posted_at_timestamp * 1000).toISOString() : null),
      experienceHint: typeof months === "number" && months > 0 ? { min: Math.round((months / 12) * 10) / 10, max: null } : undefined,
      fetchedAt: new Date(),
      raw: { ...j, job_description: undefined, job_highlights: undefined } as unknown as Record<string, unknown>,
    });
  }
  return out;
}

function highlightsText(h: Record<string, string[]> | undefined): string {
  if (!h) return "";
  return Object.entries(h)
    .map(([k, v]) => `${k}:\n${v.map((s) => `- ${htmlToText(s)}`).join("\n")}`)
    .join("\n\n");
}

/** City/state/country with the country NAMED; a remote flag keeps the geo ("Remote - India"). */
function jsearchLocation(j: JSearchJob): string | null {
  const cc = j.job_country?.trim().toUpperCase() ?? "";
  const country = cc ? (COUNTRY_NAMES[cc] ?? cc) : "";
  const where = [j.job_city, j.job_state, country].filter((s): s is string => !!s && !!s.trim()).join(", ") || j.job_location?.trim() || "";
  if (j.job_is_remote) return where ? `Remote - ${where}` : "Remote";
  return where || null;
}

/**
 * Prefer the employer's own ATS / careers link over a board's re-host: it's the posting's
 * source of truth, earns the ATS-link trust bonus, and lets the detector find the board.
 */
function pickApplyLink(j: JSearchJob): string | null {
  const opts = (j.apply_options ?? []).filter((o): o is JSearchApplyOption & { apply_link: string } => !!o.apply_link);
  const ats = opts.find((o) => classifyLink(o.apply_link).kind === "ats");
  const own = opts.find((o) => classifyLink(o.apply_link).kind === "careers");
  return ats?.apply_link ?? own?.apply_link ?? j.job_apply_link ?? opts[0]?.apply_link ?? j.job_google_link ?? null;
}

/**
 * Stated pay with an explicit currency only, annualised (YEAR as-is, MONTH ×12). Without a
 * currency an India listing's number could be USD or INR — and a stated salary is parsed
 * with high confidence, which the salary floor may hard-exclude on (invariant #4).
 */
function jsearchSalary(j: JSearchJob): string | null {
  const cur = j.job_salary_currency?.trim().toUpperCase();
  if (!cur || !["INR", "USD", "EUR", "GBP"].includes(cur)) return null;
  const mult = j.job_salary_period === "YEAR" ? 1 : j.job_salary_period === "MONTH" ? 12 : 0;
  if (!mult) return null;
  const min = j.job_min_salary && j.job_min_salary > 0 ? Math.round(j.job_min_salary * mult) : null;
  const max = j.job_max_salary && j.job_max_salary > 0 ? Math.round(j.job_max_salary * mult) : null;
  if (min == null && max == null) return null;
  if (min != null && max != null && max !== min) return `${cur} ${min} - ${max}`;
  return `${cur} ${min ?? max}`;
}
