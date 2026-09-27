import type { RawPosting } from "@jobflow/core";
import { htmlToText } from "../types.js";
import { asNumber, asString, decodeEntities, tryParseJson } from "./parse.js";

/**
 * Darwinbox careers boards (Porter, Upstox, Rapido…) — a LOCAL-AGENT-ONLY board ATS
 * (invariant #1). Darwinbox is the HRMS a lot of Indian startups hire through, and its
 * careers sites sit behind Cloudflare, which rejects non-browser clients (TLS
 * fingerprint + a bot stub served to headless UAs), so the cloud can't poll them. The
 * local agent reads the board in the user's own browser instead, through `ingestCompany`
 * with this adapter, so the full-board staleness diff is the same one cloud boards get.
 *
 * Verified live 2026-09-27 (browser session, no login): the careers SPA
 *   GET  https://{tenant}.darwinbox.in/ms/candidatev2/main/careers/allJobs
 * loads its listing with
 *   POST /ms/candidateapi/job/alljobs?companyId=main
 *        {"companyId":"main","page":1,"sort_option":"new","limit":N}
 *   → {"status":"success","data":[job…],"job_counts":<board total>}
 * Each job already carries the full JD (`jd`, entity-encoded HTML), a structured
 * experience range, the office locations and the publish date (`posted_on`, epoch
 * seconds) — so one call per page, no per-posting detail fetch. limit=100 is honoured.
 * Porter listed 123 jobs, Upstox 24; Rapido's tenant listed 0 that day.
 */

export interface DarwinboxBoard {
  /** careers host, e.g. "porter.darwinbox.in" */
  host: string;
  /** careers "company" inside the tenant — "main" unless the tenant runs group sites */
  companyId: string;
}

/** Board page size — the SPA asks for 10; the endpoint honours 100 (fewer page loads). */
export const DARWINBOX_PAGE_SIZE = 100;
/** Politeness + sanity cap: 10 × 100 = 1000 jobs; a bigger board is fetched next time. */
export const DARWINBOX_MAX_PAGES = 10;

/**
 * Registry slug → board. The slug is the tenant subdomain ("porter"); a bare
 * `{tenant}.darwinbox.in` host is accepted too. Anything else is rejected, so a slug
 * can never steer the agent's browser to an arbitrary host.
 */
export function parseDarwinboxSlug(slug: string | null | undefined): DarwinboxBoard | null {
  const s = (slug ?? "").trim().toLowerCase();
  const tenant = s.endsWith(".darwinbox.in") ? s.slice(0, -".darwinbox.in".length) : s;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant)) return null;
  return { host: `${tenant}.darwinbox.in`, companyId: "main" };
}

/** The careers page the SPA serves — the agent lands here first (first-party context). */
export function darwinboxCareersUrl(b: DarwinboxBoard): string {
  return `https://${b.host}/ms/candidatev2/${b.companyId}/careers/allJobs`;
}

/** The listing endpoint the careers SPA itself POSTs to. */
export function darwinboxJobsApiUrl(b: DarwinboxBoard): string {
  return `https://${b.host}/ms/candidateapi/job/alljobs?companyId=${encodeURIComponent(b.companyId)}`;
}

/** Request body for one listing page (1-based), newest first — mirrors the SPA's own. */
export function darwinboxJobsBody(b: DarwinboxBoard, page: number, limit = DARWINBOX_PAGE_SIZE): string {
  return JSON.stringify({ companyId: b.companyId, page, sort_option: "new", limit });
}

/** Public job-detail page (where the candidate applies). */
export function darwinboxJobUrl(b: DarwinboxBoard, jobId: string): string {
  return `https://${b.host}/ms/candidatev2/${b.companyId}/careers/jobDetails/${encodeURIComponent(jobId)}`;
}

export interface DarwinboxPage {
  postings: RawPosting[];
  /** jobs in this page's `data` (before parsing drops malformed ones) */
  pageLength: number;
  /** the board total the API reports (`job_counts`), when present */
  total: number | null;
}

/**
 * Parse one `alljobs` response body. Returns null when the body isn't the listing
 * (bot page, error JSON, `status` ≠ success) so the caller can abort the whole board
 * rather than diff against a partial one (§3).
 */
export function parseDarwinboxJobs(text: string, board: DarwinboxBoard, companyName: string): DarwinboxPage | null {
  const root = tryParseJson<Record<string, unknown>>(text);
  if (!root || typeof root !== "object" || !Array.isArray(root.data)) return null;
  if (root.status != null && String(root.status).toLowerCase() !== "success") return null;
  const data = root.data as unknown[];
  const postings: RawPosting[] = [];
  for (const j of data) {
    const raw = darwinboxJobToRaw(j, board, companyName);
    if (raw) postings.push(raw);
  }
  const total = asNumber(root.job_counts);
  return { postings, pageLength: data.length, total: total != null && total >= 0 ? total : null };
}

function darwinboxJobToRaw(j: unknown, board: DarwinboxBoard, companyName: string): RawPosting | null {
  if (!j || typeof j !== "object") return null;
  const job = j as Record<string, unknown>;
  const id = asString(job.id) ?? asString(job._id);
  const title = clean(asString(job.title) ?? asString(job.designation_display_name) ?? asString(job.designation_name) ?? "");
  if (!id || !title) return null;

  const jdHtml = decodeEntities(asString(job.jd) ?? "");
  const jdBody = htmlToText(jdHtml);
  const exp = experienceOf(job);
  const expLine = exp ? `Experience: ${exp.min ?? 0}${exp.max != null ? `-${exp.max}` : "+"} years\n` : "";
  const dept = clean(asString(job.department_name_only) ?? asString(job.department_name) ?? "");

  return {
    source: "darwinbox",
    tier: "tier3",
    atsType: "darwinbox",
    atsJobId: id,
    companyName,
    companySlug: board.host.split(".")[0] ?? null,
    title,
    jdText: `${expLine}${dept ? `Department: ${dept}\n` : ""}${jdBody}`.trim(),
    jdHtml: jdHtml || null,
    locationRaw: locationOf(job),
    applyUrl: darwinboxJobUrl(board, id),
    salaryRaw: salaryOf(job),
    postedAt: postedAtOf(job),
    experienceHint: exp ?? undefined,
    fetchedAt: new Date(),
    raw: {
      id,
      jobCode: asString(job.internal_job_code) ?? null,
      department: dept || null,
      employeeType: asString(job.emp_type_name) ?? null,
    } as Record<string, unknown>,
  };
}

/** Office locations ("Mumbai, Maharashtra\r, India" → "Mumbai, Maharashtra, India"), remote-prefixed. */
function locationOf(job: Record<string, unknown>): string | null {
  const lists = [job.officelocations_without_area, job.tool_tip_locations, job.officelocation_show_arr_list];
  let places: string[] = [];
  for (const l of lists) {
    if (Array.isArray(l)) {
      places = l.map((x) => clean(String(x ?? ""))).filter(Boolean);
      if (places.length) break;
    }
  }
  if (!places.length) {
    const flat = clean(asString(job.locations) ?? "");
    if (flat && !/^multiple locations$/i.test(flat)) places = [flat];
  }
  const country = clean(asString(job.country) ?? "");
  if (!places.length && country) places = [country];
  const remote = String(job.is_remote ?? "0") === "1" || job.is_remote === true;
  const joined = [...new Set(places)].join("; ");
  if (remote) return `Remote - ${joined || country || "India"}`;
  return joined || null;
}

/** Structured range from experience_from/_to ("3","5"); the recruiter's own filter (§11.2). */
function experienceOf(job: Record<string, unknown>): { min: number | null; max: number | null } | null {
  const lo = numOrNull(job.experience_from);
  const hi = numOrNull(job.experience_to);
  if (lo == null && hi == null) return null;
  return { min: lo, max: hi != null && (lo == null || hi >= lo) ? hi : null };
}

/** Publish date: the careers posting window's start, else the requisition's creation. */
function postedAtOf(job: Record<string, unknown>): string | null {
  const careersFrom = (job.job_posting as { careers?: { from?: unknown } } | undefined)?.careers?.from;
  for (const v of [job.posted_on, careersFrom]) {
    const n = numOrNull(v);
    if (n != null && n > 1_000_000_000) return new Date((n < 10_000_000_000 ? n * 1000 : n)).toISOString();
  }
  const created = asString(job.created_on);
  return created && Number.isFinite(Date.parse(created)) ? new Date(created).toISOString() : null;
}

/** Salary only when the tenant publishes one (most don't) — never invented. */
function salaryOf(job: Record<string, unknown>): string | null {
  const lo = numOrNull(job.salary_min);
  const hi = numOrNull(job.salary_max);
  if (lo == null && hi == null) {
    const range = clean(asString(job.salary_range) ?? "");
    return range || null;
  }
  const cur = clean(asString(job.salary_currency) ?? "") || "INR";
  const per = clean(asString(job.salary_timeframe) ?? "");
  const band = lo != null && hi != null ? `${lo} - ${hi}` : String(lo ?? hi);
  return `${cur} ${band}${per ? ` ${per}` : ""}`;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** Decode + collapse whitespace; drops the stray "\r" Darwinbox leaves before ", India". */
function clean(s: string): string {
  return decodeEntities(s).replace(/\s*\r(?=\s*,)/g, "").replace(/\s+/g, " ").trim();
}
