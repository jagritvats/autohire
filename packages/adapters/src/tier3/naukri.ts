import type { RawPosting } from "@jobflow/core";
import { asString, collectObjects, decodeEntities, firstMatch, matchAllGroups, pick, stripTags } from "./parse.js";

/**
 * Naukri (Tier-3, local agent only, §7.1) — India's largest board and the primary
 * source for good-paying software/engineering roles in India. Runs through the user's
 * OWN authenticated session (Naukri is Cloudflare-gated; anonymous fetches 403).
 *
 * Two fetch surfaces, best → fallback:
 *   1. jobapi/v3/search — the internal JSON the SRP itself XHRs. Stable for years,
 *      markup-independent, and carries the AmbitionBox rating per card (§11.5). Needs
 *      `appid`/`systemid` headers, so it's fetched via the agent's `localFetchJson`
 *      (page.evaluate → same-origin fetch with the session cookies).
 *   2. the rendered SRP DOM (`div.srp-jobtuple-wrapper[data-job-id]`) — parsed when only
 *      `localFetch` (page.content()) is available.
 *
 * "good-paying" is expressed as a soft `ctcFilter` LPA bucket on the QUERY (shaping what
 * we poll), never a hard match filter — the ranker still weights salary (invariant #4).
 */

const ORIGIN = "https://www.naukri.com";

/** Naukri CTC buckets, in LPA. `ctcFilter` OR's the ones we pass. */
const CTC_BUCKETS: Array<{ token: string; min: number; max: number }> = [
  { token: "0to3", min: 0, max: 3 },
  { token: "3to6", min: 3, max: 6 },
  { token: "6to10", min: 6, max: 10 },
  { token: "10to15", min: 10, max: 15 },
  { token: "15to25", min: 15, max: 25 },
  { token: "25to50", min: 25, max: 50 },
  { token: "50to75", min: 50, max: 75 },
  { token: "75to100", min: 75, max: 100 },
];

/** Map our hub slugs → Naukri city slugs (NCR is one facet on Naukri). */
const NAUKRI_CITY: Record<string, string> = {
  bengaluru: "bengaluru",
  bangalore: "bengaluru",
  pune: "pune",
  hyderabad: "hyderabad",
  chennai: "chennai",
  mumbai: "mumbai",
  delhi: "delhi-ncr",
  gurgaon: "delhi-ncr",
  gurugram: "delhi-ncr",
  noida: "delhi-ncr",
  kolkata: "kolkata",
  ahmedabad: "ahmedabad",
  remote: "remote",
};

export interface NaukriSearchOptions {
  query: string;
  /** hub slug (mapped to a Naukri city) or "" for country-wide. */
  location?: string;
  /** soft CTC floor in LPA → `ctcFilter` buckets at/above it. */
  minLpa?: number;
  /** recency window in days → `jobAge`. */
  freshnessDays?: number;
  /** candidate experience in whole years → `experience`. */
  experienceYears?: number;
  /** page size (jobapi accepts up to ~100). */
  pageSize?: number;
}

/** CTC buckets whose top exceeds the floor — i.e. the "good-paying" bands. */
export function ctcBucketsForFloor(minLpa: number): string[] {
  if (!minLpa || minLpa <= 0) return [];
  const picked = CTC_BUCKETS.filter((b) => b.max > minLpa).map((b) => b.token);
  return picked.length ? picked : ["75to100"]; // floor above the top band → the top band
}

function citySlug(location: string | undefined): string {
  const loc = (location ?? "").trim().toLowerCase();
  if (!loc) return "india";
  return NAUKRI_CITY[loc] ?? loc.replace(/\s+/g, "-");
}

function seoKey(query: string, location: string | undefined): string {
  const role = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${role}-jobs-in-${citySlug(location)}`;
}

/** Build the internal jobapi/v3/search URL (JSON) for a good-paying India SWE query. */
export function buildNaukriApiUrl(opts: NaukriSearchOptions): string {
  const params = new URLSearchParams({
    noOfResults: String(opts.pageSize ?? 100),
    urlType: "search_by_key_loc",
    searchType: "adv",
    keyword: opts.query,
    pageNo: "1",
    sort: "f", // by date
    seoKey: seoKey(opts.query, opts.location),
  });
  const city = citySlug(opts.location);
  if (city && city !== "india") params.set("location", city);
  if (opts.experienceYears != null) params.set("experience", String(opts.experienceYears));
  if (opts.freshnessDays && opts.freshnessDays > 0) params.set("jobAge", String(Math.round(opts.freshnessDays)));
  let qs = params.toString();
  for (const b of ctcBucketsForFloor(opts.minLpa ?? 0)) qs += `&ctcFilter=${b}`; // OR'd, repeatable
  return `${ORIGIN}/jobapi/v3/search?${qs}`;
}

/** Headers the jobapi requires (alongside the session cookies + a real UA). */
export function naukriApiHeaders(): Record<string, string> {
  return { appid: "109", systemid: "Naukri", Accept: "application/json" };
}

/** Build the SEO search-results page URL (for the DOM-fallback path). */
export function buildNaukriSeoUrl(opts: NaukriSearchOptions): string {
  const params = new URLSearchParams({ k: opts.query, sort: "f" });
  const city = citySlug(opts.location);
  if (city && city !== "india") params.set("l", city);
  if (opts.experienceYears != null) params.set("experience", String(opts.experienceYears));
  if (opts.freshnessDays && opts.freshnessDays > 0) params.set("jobAge", String(Math.round(opts.freshnessDays)));
  let qs = params.toString();
  for (const b of ctcBucketsForFloor(opts.minLpa ?? 0)) qs += `&ctcFilter=${b}`;
  return `${ORIGIN}/${seoKey(opts.query, opts.location)}?${qs}`;
}

// ── JSON path (jobapi/v3/search response) ──────────────────────────────────────

/** Parse the jobapi JSON body into RawPostings. Tolerant of shape drift. */
export function parseNaukriApiJson(text: string, limit = 25): RawPosting[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  // `jobDetails` at the top level, else deep-find the array of job tuples by shape.
  let tuples = (root as { jobDetails?: unknown }).jobDetails;
  if (!Array.isArray(tuples)) {
    tuples = collectObjects(root, (o) => o.jobId != null && (o.title != null || o.jobTitle != null), 800);
  }
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const t of tuples as unknown[]) {
    if (out.length >= limit) break;
    const raw = naukriTupleToRaw(t);
    if (raw && !seen.has(raw.atsJobId)) {
      seen.add(raw.atsJobId);
      out.push(raw);
    }
  }
  return out;
}

/** Map one jobapi tuple → RawPosting (also used for any embedded tuple). */
function naukriTupleToRaw(t: unknown): RawPosting | null {
  if (!t || typeof t !== "object") return null;
  const job = t as Record<string, unknown>;
  const jobId = asString(pick(job, "jobId", "id"));
  const title = asString(pick(job, "title", "jobTitle"));
  const companyName = asString(pick(job, "companyName")) ?? asString(pluck(job, "companyDetail", "name"));
  if (!jobId || !title || !companyName) return null;

  const ph = placeholders(job);
  const locationRaw = ph.location ?? asString(pick(job, "location")) ?? "India";
  const expLabel = ph.experience ?? asString(pluck(job, "experience", "label"));
  const salaryLabel = normalizeSalaryLabel(ph.salary ?? asString(pluck(job, "salaryDetail", "label")));
  const skills = asString(pick(job, "tagsAndSkills")) ?? "";
  const rel = asString(pick(job, "jdURL", "staticUrl", "jobUrl"));
  const applyUrl = rel ? (rel.startsWith("http") ? rel : `${ORIGIN}${rel}`) : `${ORIGIN}/job-listings-${jobId}`;
  const displayed = createdIso(pick(job, "createdDate")) ?? relativeLabelIso(asString(pick(job, "footerPlaceholderLabel")));
  const postedAt = originalPostedAt(jobId, displayed);
  const postedByAgency = consultantFlag(job);

  const jdText = [
    `${title} at ${companyName}.`,
    expLabel ? `Experience: ${expLabel}.` : "",
    locationRaw ? `Location: ${locationRaw}.` : "",
    salaryLabel ? `CTC: ${salaryLabel}.` : "",
    skills ? `Skills: ${skills.replace(/,/g, ", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    source: "naukri",
    tier: "tier3",
    atsType: "unknown",
    atsJobId: jobId,
    companyName,
    companySlug: null,
    title,
    jdText,
    jdHtml: null,
    locationRaw,
    applyUrl,
    salaryRaw: salaryLabel,
    postedAt,
    ...(postedByAgency !== undefined ? { postedByAgency } : {}),
    fetchedAt: new Date(),
    // keep the free AmbitionBox rating (§11.5) for later enrichment without a re-fetch;
    // the displayed date is kept beside the id-derived one so the rule can be audited
    raw: { jobId, ambitionBox: pick(job, "ambitionBoxData") ?? null, displayedPostedAt: displayed } as Record<string, unknown>,
  };
}

/**
 * Naukri's "posted by a consultant" marker on a job tuple. UNVERIFIED key: the search
 * tuples couldn't be inspected live (Naukri's bot wall answered 403 on 2026-09-27), and
 * the job-detail JSON is known to carry a boolean `consultant`. So only explicit
 * booleans under the plausible keys count; absent → undefined (the trust score's prose
 * and poster-name checks still apply), never a guess.
 */
export function consultantFlag(job: Record<string, unknown>): boolean | undefined {
  for (const key of ["consultant", "isConsultant", "consultantJob", "postedByConsultant"]) {
    const v = job[key];
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "y" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "n" || s === "no") return false;
    }
  }
  return undefined;
}

/** Extract the {type,label} placeholder trio Naukri uses for loc/exp/salary. */
function placeholders(job: Record<string, unknown>): { location?: string; experience?: string; salary?: string } {
  const arr = pick(job, "placeholders", "placeHolders");
  const res: { location?: string; experience?: string; salary?: string } = {};
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      const type = String((p as Record<string, unknown>).type ?? "").toLowerCase();
      const label = asString((p as Record<string, unknown>).label);
      if (!label) continue;
      if (type === "location") res.location = res.location ? `${res.location}, ${label}` : label;
      else if (type === "experience") res.experience = label;
      else if (type === "salary") res.salary = label;
    }
  }
  return res;
}

// ── DOM path (rendered SRP fallback) ───────────────────────────────────────────

/** Parse the rendered SRP DOM into RawPostings (fallback when only page.content()). */
export function parseNaukriHtml(html: string, limit = 25): RawPosting[] {
  if (!html) return [];
  // split KEEPING each wrapper's opening tag in-chunk (data-job-id lives on it)
  const byWrapper = html
    .split(/(?=<div[^>]*class="[^"]*srp-jobtuple-wrapper)/i)
    .filter((c) => /srp-jobtuple-wrapper/i.test(c));
  const chunks = byWrapper.length ? byWrapper : splitByDataJobId(html);
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const card of chunks) {
    if (out.length >= limit) break;
    const jobId =
      firstMatch(/data-job-id=["'](\d+)["']/, card) ??
      firstMatch(/\/job-listings-[^"']*?-(\d{8,})(?:[/?"']|$)/, card);
    if (!jobId || seen.has(jobId)) continue;

    const href = firstMatch(/<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*href=["']([^"']+)["']/, card) ??
      firstMatch(/href=["'](\/job-listings-[^"']+)["']/, card);
    const title =
      firstMatch(/<a[^>]*class="[^"]*\btitle\b[^"]*"[^>]*title=["']([^"']+)["']/, card) ??
      readClassText(/\btitle\b/, card);
    const company = readClassText(/comp-name/, card) ?? readClassText(/subTitle/, card);
    if (!title || !company) continue;
    seen.add(jobId);

    const exp = readClassText(/exp-wrap/, card) ?? readClassText(/expwdth/, card);
    const sal = normalizeSalaryLabel(readClassText(/sal-wrap/, card) ?? readClassText(/\bsal\b/, card));
    const loc = readClassText(/loc-wrap/, card) ?? readClassText(/locWdth/, card) ?? "India";
    const skills = matchAllGroups(/<li[^>]*class="[^"]*tag-li[^"]*"[^>]*>([\s\S]*?)<\/li>/gi, card)
      .map((s) => stripTags(s))
      .filter(Boolean)
      .join(", ");
    const postedLabel = readClassText(/job-post-day/, card);
    const displayed = relativeLabelIso(postedLabel) ?? postedLabel;
    const postedAt = originalPostedAt(jobId, displayed);
    const applyUrl = href ? (href.startsWith("http") ? href : `${ORIGIN}${href}`) : `${ORIGIN}/job-listings-${jobId}`;

    const jdText = [
      `${title} at ${company}.`,
      exp ? `Experience: ${exp}.` : "",
      loc ? `Location: ${loc}.` : "",
      sal ? `CTC: ${sal}.` : "",
      skills ? `Skills: ${skills}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    out.push({
      source: "naukri",
      tier: "tier3",
      atsType: "unknown",
      atsJobId: jobId,
      companyName: company,
      companySlug: null,
      title,
      jdText,
      jdHtml: null,
      locationRaw: loc,
      applyUrl,
      salaryRaw: sal,
      postedAt: postedAt ?? null,
      fetchedAt: new Date(),
      raw: { jobId, displayedPostedAt: displayed ?? null } as Record<string, unknown>,
    });
  }
  return out;
}

function splitByDataJobId(html: string): string[] {
  return html
    .split(/(?=data-job-id=)/i)
    .filter((c) => /data-job-id=/i.test(c));
}

/** Read collapsed text of the first element whose class matches `classRe`. */
function readClassText(classRe: RegExp, card: string): string | null {
  const re = new RegExp(`<[^>]*class="[^"]*${classRe.source}[^"]*"[^>]*>([\\s\\S]*?)<\\/`, "i");
  const m = re.exec(card);
  const txt = m && m[1] ? stripTags(m[1]) : "";
  return txt || null;
}

// ── shared helpers ──────────────────────────────────────────────────────────────

/** "Not disclosed" / empty → null; else the trimmed CTC label. */
function normalizeSalaryLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const s = decodeEntities(label).trim();
  if (!s || /not\s*disclosed|not\s*mentioned|unpaid/i.test(s)) return null;
  return s;
}

// ── original post date from the job id ─────────────────────────────────────────

const DAY_MS = 86_400_000;
/** IST = UTC+5:30 — Naukri stamps ids with the Indian calendar day. */
const IST_OFFSET_MS = 5.5 * 3_600_000;
/** the id date must beat the displayed one by more than this to count as a refresh */
const REFRESH_MIN_GAP_MS = 2 * DAY_MS;
/** ids older than this are not trusted as a date (the pattern is unverified that far back) */
const ID_DATE_MAX_AGE_MS = 365 * DAY_MS;

/**
 * Decode the DDMMYY prefix of a Naukri job id ("100726919408" → 10 Jul 2026, 00:00 IST).
 * Null unless it's a real calendar date (no 31 Feb) with a 12+ digit numeric id.
 *
 * Evidence (2026-09-27): a third-party claim says ids start with the date the job was
 * FIRST posted, so a "refreshed" listing shows a recent date but keeps its old id. Live
 * verification through a browser was blocked (Naukri answered 403 Access Denied to the
 * first page load; we stopped there, per policy). Search-index data corroborates the
 * STRUCTURE: 14/14 indexed job-listing ids decode to valid dates, and 9 carry an
 * independently indexed post date — 7 match exactly, 2 are one day apart (IST vs UTC).
 * The refresh behaviour itself is NOT verified, hence the guards in `originalPostedAt`.
 */
export function naukriIdDate(jobId: string | null | undefined): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})\d{6,}$/.exec((jobId ?? "").trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = 2000 + Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const utc = Date.UTC(yyyy, mm - 1, dd);
  const check = new Date(utc);
  if (check.getUTCDate() !== dd || check.getUTCMonth() !== mm - 1) return null; // 31 Feb etc.
  return new Date(utc - IST_OFFSET_MS);
}

/**
 * The date to report as `postedAt`: the id-derived first-posted date when it is
 * plausible AND clearly earlier than the displayed ("refreshed") date; else the
 * displayed date unchanged. Guards (the claim is unverified live, so err towards the
 * displayed date): valid calendar date, not in the future, within the last year, and
 * more than 2 days before the displayed date. No parseable displayed date → no change.
 */
export function originalPostedAt(jobId: string, displayed: string | null, now = Date.now()): string | null {
  const shown = displayed ? Date.parse(displayed) : NaN;
  if (!Number.isFinite(shown)) return displayed;
  const id = naukriIdDate(jobId);
  if (!id) return displayed;
  const t = id.getTime();
  if (t > now + DAY_MS) return displayed; // future — not a date after all
  if (now - t > ID_DATE_MAX_AGE_MS) return displayed; // too old to trust the pattern
  if (shown - t <= REFRESH_MIN_GAP_MS) return displayed; // same posting day (± timezone)
  return id.toISOString();
}

/**
 * Naukri's relative footer label → an ISO date ("3 Days Ago", "Just Now", "Today",
 * "30+ Days Ago", "Few Hours Ago"). "30+" reads as 30 — a lower bound on age, which is
 * the honest direction for freshness. Null for anything else.
 */
export function relativeLabelIso(label: string | null | undefined, now = Date.now()): string | null {
  const s = (label ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^(just now|today|few hours ago|\d+\s*hours? ago|\d+\s*min(ute)?s? ago)$/.test(s)) return new Date(now).toISOString();
  const m = /^(\d+)\+?\s*days?\s*ago$/.exec(s);
  if (m) return new Date(now - Number(m[1]) * DAY_MS).toISOString();
  return null;
}

/** epoch-ms number → ISO string; a "3 Days Ago" label passes through as-is (nullable). */
function createdIso(v: unknown): string | null {
  if (typeof v === "number" && v > 0) return new Date(v).toISOString();
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1_000_000_000_000) return new Date(n).toISOString();
    return v || null;
  }
  return null;
}

/** nested pick: obj[a][b] with case tolerance. */
function pluck(obj: Record<string, unknown>, a: string, b: string): unknown {
  const inner = pick(obj, a);
  if (inner && typeof inner === "object") return pick(inner as Record<string, unknown>, b);
  return undefined;
}
