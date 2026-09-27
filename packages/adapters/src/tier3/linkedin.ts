import type { RawPosting } from "@jobflow/core";
import type { FetchTarget } from "../types.js";
import { decodeEntities, firstMatch, matchAllGroups, stripTags } from "./parse.js";

/**
 * LinkedIn jobs (Tier-3, local agent only, §7.1). Runs through the user's OWN session.
 *
 * Anchor choice (verified 2026): the authenticated Voyager /jobs/search page renders a
 * VIRTUALIZED list — `page.content()` only sees the handful of cards painted so far, so
 * it's a poor scrape target. The unauthenticated guest fragment
 *   /jobs-guest/jobs/api/seeMoreJobPostings/search
 * returns 10 STATIC `<li>` cards with ZERO JS, each carrying the immutable job id in
 * `data-entity-urn="urn:li:jobPosting:<id>"` plus stable semantic classes. Loading that
 * fragment through the logged-in session is both simpler and more robust, so that's what
 * we build + parse here. LinkedIn India exposes no salary on cards (f_SB2 is US-only), so
 * the experience facet (f_E) is matched to YOUR years so the sweep isn't senior-only; LPA
 * is recovered from the JD downstream.
 */

const GUEST_SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

/** India country + major tech-hub LinkedIn geoIds (scope the search reliably). */
const GEO_IDS: Record<string, string> = {
  india: "102713980",
  bengaluru: "105214831",
  bangalore: "105214831",
  mumbai: "106164952",
  delhi: "106187582",
  "new delhi": "106187582",
  gurgaon: "115884833",
  gurugram: "115884833",
  noida: "104869687",
  hyderabad: "105556991",
  chennai: "114467055",
  pune: "114806696",
};

export interface LinkedInSearchOptions {
  query: string;
  /** India hub slug (maps to a geoId) or "" for country-wide. */
  location?: string;
  /** recency window in days → f_TPR seconds. */
  freshnessDays?: number;
  /** result offset (guest page size is a fixed 10). */
  start?: number;
  /** candidate YoE → f_E experience levels (default: entry → mid-senior). */
  experienceYears?: number;
}

/**
 * LinkedIn f_E: 1 intern · 2 entry · 3 associate · 4 mid-senior · 5 director · 6 exec.
 * Pinning 4,5,6 (the old "bias toward CTC") made the sweep senior-only for a ~2-YoE
 * profile; pick the band around the candidate's actual years, one step up for stretch.
 */
export function linkedInExperienceLevels(yoe: number | undefined): string {
  if (yoe == null || !Number.isFinite(yoe)) return "2,3,4";
  if (yoe < 1) return "1,2";
  if (yoe < 5) return "2,3,4";
  if (yoe < 8) return "3,4";
  return "4,5";
}

/** Build the guest job-search fragment URL for a good-paying India SWE query. */
export function buildLinkedInUrl(opts: LinkedInSearchOptions): string {
  const loc = (opts.location ?? "").trim().toLowerCase();
  const geoId = GEO_IDS[loc] ?? GEO_IDS.india!;
  const params = new URLSearchParams({
    keywords: opts.query,
    location: loc ? title(loc) : "India",
    geoId,
    f_E: linkedInExperienceLevels(opts.experienceYears),
    f_WT: "1,2,3", // on-site + remote + hybrid (India-workable is scored, not filtered)
    f_JT: "F", // full-time
    sortBy: "DD", // most recent first
    start: String(opts.start ?? 0),
  });
  if (opts.freshnessDays && opts.freshnessDays > 0) {
    params.set("f_TPR", `r${Math.round(opts.freshnessDays * 86_400)}`);
  }
  return `${GUEST_SEARCH}?${params.toString()}`;
}

/**
 * Parse the guest fragment (or a full guest SEO page) into RawPostings. Anchors on
 * `data-entity-urn` / the `/jobs/view/<slug>-<id>` href for the immutable job id; reads
 * the human fields from the stable `base-search-card__*` / `job-search-card__*` classes.
 */
export function parseLinkedInJobs(html: string, limit = 25): RawPosting[] {
  if (!html) return [];
  const cards = splitCards(html);
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (out.length >= limit) break;
    const jobId =
      firstMatch(/urn:li:jobPosting:(\d+)/, card) ??
      firstMatch(/\/jobs\/view\/[^"'?]*?-(\d{6,})(?:[/?"']|$)/, card);
    if (!jobId || seen.has(jobId)) continue;

    const title =
      firstMatch(/class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)</, card) ??
      readTagText(/base-search-card__title/, card);
    const company =
      firstMatch(/class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/, card) ??
      readTagText(/base-search-card__subtitle/, card);
    if (!title || !company) continue;
    seen.add(jobId);

    const location = readTagText(/job-search-card__location/, card);
    const postedAt = firstMatch(/<time[^>]*datetime=["']([^"']+)["']/, card);
    const href =
      firstMatch(/href=["'](https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"'?]+)/, card) ??
      `https://www.linkedin.com/jobs/view/${jobId}`;

    out.push({
      source: "linkedin",
      tier: "tier3",
      atsType: "unknown",
      atsJobId: jobId,
      companyName: cleanText(company),
      companySlug: null,
      title: cleanText(title),
      // Cards carry no JD; seed jdText from the visible fields so skills/level parse has
      // signal. Salary stays unknown (correct — never invent), so it won't hard-exclude.
      jdText: [cleanText(title), cleanText(company), location ?? ""].filter(Boolean).join(" · "),
      jdHtml: null,
      locationRaw: location ?? "India",
      applyUrl: stripQuery(href),
      salaryRaw: null,
      postedAt: postedAt ?? null,
      fetchedAt: new Date(),
      raw: { jobId, source: "linkedin_guest" } as Record<string, unknown>,
    });
  }
  return out;
}

/** Split into per-card HTML — one `<li>`/`base-card` block each. */
function splitCards(html: string): string[] {
  // Prefer <li>…</li> (guest fragment is a bare <ul> of <li>); fall back to base-card divs.
  const byLi = matchAllGroups(/<li[^>]*>([\s\S]*?)<\/li>/gi, html);
  const withUrn = byLi.filter((c) => /urn:li:jobPosting:|\/jobs\/view\//.test(c));
  if (withUrn.length) return withUrn;
  // fallback: chunk on base-card boundaries
  return html
    .split(/<div[^>]*class="[^"]*base-card[^"]*"/i)
    .slice(1)
    .map((c) => c);
}

/** Read the text content of the first element whose class matches `classRe`. */
function readTagText(classRe: RegExp, card: string): string | null {
  const re = new RegExp(`<[^>]*class="[^"]*${classRe.source}[^"]*"[^>]*>([\\s\\S]*?)<`, "i");
  const m = re.exec(card);
  return m && m[1] ? cleanText(m[1]) : null;
}

function cleanText(s: string): string {
  return stripTags(decodeEntities(s)).replace(/\s+/g, " ").trim();
}
function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i >= 0 ? url.slice(0, i) : url;
}
function title(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
