import type { RawPosting } from "@jobflow/core";
import { asNumber, asString, extractNextData } from "./parse.js";

/**
 * Peerlist jobs (Tier-3 discovery feed, local agent only, invariant #1). Peerlist's job
 * board mixes startups posting directly with roles it lists from larger companies' own
 * boards. It sits behind Cloudflare, which challenges non-browser clients (its
 * `_next/data` JSON routes answer "Just a moment…" to anything but a real browser), so
 * it's read in the user's own browser session.
 *
 * Verified live 2026-09-27 (browser, no login): the server-rendered pages
 *   https://peerlist.io/jobs?page=N                  (all roles, newest first)
 *   https://peerlist.io/jobs/role/{role}?page=N      (one role family)
 * embed `__NEXT_DATA__` → props.pageProps.jobsData = { jobs: [50 per page], page: <next>,
 * cursor }. Each job: jobId, company{name, profileHandle}, jobTitle, skills[], jobType,
 * locationPreference (remote|hybrid|in-office), location[{city,country,countryCode}],
 * experience{min,max}, salary{currency,min,max,unit}, publishedAt (ISO). There is no
 * JD on the list page; title + skills + structured fields seed the text. A 3rd rapid
 * page load drew a Cloudflare challenge, so the adapter stays at a couple of pages per
 * run, spaced out.
 */

const ORIGIN = "https://peerlist.io";

/** Role families Peerlist exposes as /jobs/role/{slug} (from its own jobs page, 2026-09). */
export const PEERLIST_ROLES = [
  "software-engineer",
  "backend-engineer",
  "full-stack-engineer",
  "frontend-engineer",
  "devops",
  "site-reliability-engineer",
  "cloud-engineer",
  "data-engineer",
  "data-scientist",
  "machine-learning-engineer",
  "ai-engineer",
  "mobile-developer",
  "android-developer",
  "ios-developer",
  "security-engineer",
  "qa-engineer",
  "embedded-engineer",
  "software-architect",
  "engineering-manager",
  "design-engineer",
  "devrel",
  "remote",
] as const;

/** Free-text query → a Peerlist role family, or null (→ the all-roles listing). */
export function peerlistRoleFor(query: string | null | undefined): string | null {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return null;
  const slug = q.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if ((PEERLIST_ROLES as readonly string[]).includes(slug)) return slug;
  if (/full[\s-]?stack/.test(q)) return "full-stack-engineer";
  if (/back[\s-]?end|java|golang|\bgo\b|node|python|platform/.test(q)) return "backend-engineer";
  if (/front[\s-]?end|react|angular/.test(q)) return "frontend-engineer";
  if (/devops/.test(q)) return "devops";
  if (/\bsre\b|site reliability/.test(q)) return "site-reliability-engineer";
  if (/\bml\b|machine learning/.test(q)) return "machine-learning-engineer";
  if (/data eng/.test(q)) return "data-engineer";
  if (/android/.test(q)) return "android-developer";
  if (/\bios\b/.test(q)) return "ios-developer";
  if (/mobile/.test(q)) return "mobile-developer";
  if (/\bqa\b|sdet|test/.test(q)) return "qa-engineer";
  if (/\bsde\b|\bswe\b|software|developer|engineer/.test(q)) return "software-engineer";
  return null;
}

/** Listing URL for a role family (null → all roles), 1-based page. */
export function buildPeerlistUrl(opts: { role?: string | null; page?: number } = {}): string {
  const base = opts.role ? `${ORIGIN}/jobs/role/${encodeURIComponent(opts.role)}` : `${ORIGIN}/jobs`;
  return opts.page && opts.page > 1 ? `${base}?page=${opts.page}` : base;
}

/**
 * Peerlist's job-page slug: lowercase, drop every non-alphanumeric (dashes too), trim,
 * then one "-" per space — so "SDET - Python Automation" → "sdet--python-automation".
 * Matched 100/100 hrefs on the live pages.
 */
export function peerlistTitleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s/g, "-");
}

export function peerlistJobUrl(handle: string, title: string, jobId: string): string {
  return `${ORIGIN}/company/${encodeURIComponent(handle)}/careers/${peerlistTitleSlug(title)}/${jobId.toLowerCase()}`;
}

export interface PeerlistPage {
  postings: RawPosting[];
  /** the next page number Peerlist advertises, when there is one */
  nextPage: number | null;
}

/** Parse one server-rendered Peerlist jobs page. Null when it isn't one (challenge page…). */
export function parsePeerlistPage(html: string): PeerlistPage | null {
  const next = extractNextData(html);
  const jobsData = (next?.props as { pageProps?: { jobsData?: unknown } } | undefined)?.pageProps?.jobsData as
    | { jobs?: unknown; page?: unknown }
    | undefined;
  if (!jobsData || !Array.isArray(jobsData.jobs)) return null;
  const postings: RawPosting[] = [];
  for (const j of jobsData.jobs) {
    const raw = peerlistJobToRaw(j);
    if (raw) postings.push(raw);
  }
  const np = asNumber(jobsData.page);
  return { postings, nextPage: np != null && np > 1 && jobsData.jobs.length > 0 ? np : null };
}

interface PlLocation {
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
  preference?: string;
}

function peerlistJobToRaw(j: unknown): RawPosting | null {
  if (!j || typeof j !== "object") return null;
  const job = j as Record<string, unknown>;
  const jobId = asString(job.jobId);
  const title = (asString(job.jobTitle) ?? "").trim();
  const company = (job.company ?? {}) as { name?: unknown; profileHandle?: unknown };
  const companyName = (asString(company.name) ?? "").trim();
  if (!jobId || !title || !companyName) return null;
  const status = asString(job.status);
  if (status && status.toUpperCase() !== "PUBLISHED") return null; // closed / draft

  const skills = Array.isArray(job.skills)
    ? job.skills.map((s) => asString((s as { name?: unknown })?.name)).filter((s): s is string => !!s)
    : [];
  const exp = job.experience as { min?: unknown; max?: unknown } | undefined;
  const lo = exp ? asNumber(exp.min) : null;
  const hiRaw = exp ? asNumber(exp.max) : null;
  const hi = hiRaw != null && (lo == null || hiRaw >= lo) ? hiRaw : null;
  const jobType = asString(job.jobType);
  const locationRaw = locationOf(job);
  const salaryRaw = salaryOf(job.salary);
  const handle = asString(company.profileHandle);

  const jdText = [
    `${title} at ${companyName}.`,
    jobType ? `Type: ${jobType}.` : "",
    lo != null ? `Experience: ${lo}${hi != null ? `-${hi}` : "+"} years.` : "",
    locationRaw ? `Location: ${locationRaw}.` : "",
    salaryRaw ? `Compensation: ${salaryRaw}.` : "",
    skills.length ? `Skills: ${skills.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const published = asString(job.publishedAt);
  return {
    source: "peerlist",
    tier: "tier3",
    atsType: "unknown",
    atsJobId: jobId,
    companyName,
    companySlug: null,
    title,
    jdText,
    jdHtml: null,
    locationRaw,
    applyUrl: handle ? peerlistJobUrl(handle, title, jobId) : `${ORIGIN}/jobs`,
    salaryRaw,
    postedAt: published && Number.isFinite(Date.parse(published)) ? new Date(published).toISOString() : null,
    experienceHint: lo != null || hi != null ? { min: lo, max: hi } : undefined,
    fetchedAt: new Date(),
    raw: { jobId, handle: handle ?? null, jobType: jobType ?? null } as Record<string, unknown>,
  };
}

/** "Remote - India" / "Hybrid - Bengaluru, India" / "Bengaluru, India" — what parseLocation reads. */
function locationOf(job: Record<string, unknown>): string | null {
  const locs = Array.isArray(job.location) ? (job.location as PlLocation[]) : [];
  const places = [
    ...new Set(
      locs
        .map((l) => [l?.city, l?.state, l?.country].map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join(", "))
        .filter(Boolean),
    ),
  ];
  const pref = (asString(job.locationPreference) ?? locs.find((l) => l?.preference)?.preference ?? "").toLowerCase();
  const where = places.join("; ");
  if (pref === "remote") return where ? `Remote - ${where}` : "Remote"; // no geo stated ≠ worldwide
  if (pref === "hybrid") return where ? `Hybrid - ${where}` : "Hybrid";
  return where || null;
}

/** "USD 179800 - 258500 per year" / "INR 480000 - 780000"; null when no figure is stated. */
function salaryOf(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { currency?: unknown; min?: unknown; max?: unknown; unit?: unknown };
  const lo = asNumber(s.min);
  const hi = asNumber(s.max);
  if ((lo == null || lo <= 0) && (hi == null || hi <= 0)) return null;
  const cur = asString(s.currency) ?? "";
  const unit = (asString(s.unit) ?? "").toLowerCase();
  const per = /hour/.test(unit) ? " per hour" : /month/.test(unit) ? " per month" : /year|annual/.test(unit) ? " per year" : "";
  const band = lo != null && hi != null && hi >= lo ? `${lo} - ${hi}` : String(lo ?? hi);
  return `${cur} ${band}${per}`.trim();
}
