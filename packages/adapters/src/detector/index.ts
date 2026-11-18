import type { AtsType } from "@jobflow/core";
import { slugify } from "@jobflow/core";
import { httpJson, httpText } from "../types.js";
import { parseWorkdaySlug } from "../ats/workday.js";
import { parseEightfoldSlug } from "../ats/eightfold.js";
import { talentBrewQuery } from "../ats/talentbrew.js";
import { personioHost } from "../ats/personio.js";
import { teamtailorHost } from "../ats/teamtailor.js";

/**
 * ATS Detector (§ ATS Detector). Given a careers URL and/or company name, identify
 * which ATS hosts their board and extract the slug. This is the linchpin of
 * discovery: aggregators/HN/YC give company NAMES → we resolve to a board → poll
 * the ATS directly for the good data.
 *
 * Two strategies, in order:
 *   1. URL pattern extraction (when we have a careers URL)
 *   2. Slug probing — guess the slug from the name and confirm via a live API hit
 */

export interface DetectResult {
  atsType: AtsType;
  atsSlug: string | null;
  confidence: "confirmed" | "guessed" | "none";
}

// host → ats, with a capture for the slug
const URL_PATTERNS: Array<{ ats: AtsType; re: RegExp; group: number }> = [
  { ats: "greenhouse", re: /boards\.greenhouse\.io\/([^/?#]+)/i, group: 1 },
  { ats: "greenhouse", re: /job-boards\.greenhouse\.io\/([^/?#]+)/i, group: 1 },
  { ats: "greenhouse", re: /greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/i, group: 1 },
  { ats: "lever", re: /jobs\.lever\.co\/([^/?#]+)/i, group: 1 },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([^/?#]+)/i, group: 1 },
  { ats: "ashby", re: /ashbyhq\.com\/([^/?#]+)/i, group: 1 },
  // path form first: the subdomain form would read "apply.workable.com/x" as slug "apply"
  { ats: "workable", re: /apply\.workable\.com\/([^/?#]+)/i, group: 1 },
  { ats: "workable", re: /([^./]+)\.workable\.com/i, group: 1 },
  { ats: "recruitee", re: /([^./]+)\.recruitee\.com/i, group: 1 },
  { ats: "personio", re: /([^./]+)\.jobs\.personio\.(?:de|com)/i, group: 1 },
  // not the CDN/app hosts (teamtailor-cdn.com doesn't match; app./api./www. are reserved)
  { ats: "teamtailor", re: /(?<![a-z0-9.-])([a-z0-9-]+)\.teamtailor\.com/i, group: 1 },
  { ats: "bamboohr", re: /(?<![a-z0-9.-])([a-z0-9-]+)\.bamboohr\.com/i, group: 1 },
  { ats: "breezy", re: /(?<![a-z0-9.-])([a-z0-9-]+)\.breezy\.hr/i, group: 1 },
  { ats: "smartrecruiters", re: /(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/i, group: 1 },
  { ats: "rippling", re: /ats\.rippling\.com\/([^/?#]+)/i, group: 1 },
  { ats: "rippling", re: /api\.rippling\.com\/platform\/api\/ats\/v\d\/board\/([^/?#]+)/i, group: 1 },
  { ats: "jobvite", re: /jobs\.jobvite\.com\/([^/?#]+)/i, group: 1 },
  { ats: "kula", re: /careers\.kula\.ai\/([^/?#]+)/i, group: 1 },
  { ats: "keka", re: /([a-z0-9-]+)\.keka\.com/i, group: 1 },
  { ats: "zoho", re: /([a-z0-9-]+\.zohorecruit\.(?:com|in|eu))/i, group: 1 },
  { ats: "freshteam", re: /([a-z0-9-]+)\.freshteam\.com/i, group: 1 },
  // tenant subdomain = slug; local-agent-only board (see probe) — not a CDN/help host
  { ats: "darwinbox", re: /(?<![a-z0-9.-])(?!(?:cdn|help|docs|blog|status)\.)([a-z0-9-]+)\.darwinbox\.in/i, group: 1 },
];

/** path segments that are never a board slug (script/embed/API paths in page HTML). */
const RESERVED_SLUG = /^(embed|js|css|api|static|assets|v\d+|www|app|apply|wday|cxs|jobs|job|careers?|en-[a-z]{2}|cdn|help|support|docs|blog|status|marketplace|partners|media|images?)$/i;

/**
 * Every (ats, slug) a URL — or a whole careers-page HTML — points at, in pattern order.
 * Multi-part boards encode their slug: Workday "{host}/{tenant}/{site}", Eightfold
 * "{host}/{domain}". In HTML a capture can run past the closing quote, so each slug is
 * cut at the first character that can't be part of one.
 */
export function atsCandidates(text: string, pageUrl?: string): Array<{ ats: AtsType; slug: string }> {
  const out: Array<{ ats: AtsType; slug: string }> = [];
  const seen = new Set<string>();
  const add = (ats: AtsType, slug: string | undefined) => {
    if (!slug) return;
    const key = `${ats}:${slug.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ats, slug });
  };
  for (const m of text.matchAll(/\b([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/gi)) {
    if (!/^(wday|cxs)$/i.test(m[3]!)) add("workday", `${m[1]}.${m[2]}.myworkdayjobs.com/${m[1]}/${m[3]}`);
  }
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)\/careers\?[^"'\s<>]*?domain=([a-z0-9.-]+)/gi)) {
    add("eightfold", `${m[1]}/${m[2]}`);
  }
  for (const m of text.matchAll(/\b([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[a-z]{2})?\/sites\/(CX(?:_\d+)?)\b/gi)) {
    add("oracle", `${m[1]}/${m[2]}`);
  }
  if (/\bamazon\.jobs\b/i.test(text)) add("amazon", "amazon");
  if (/\batlassian\.com\/company\/careers\b/i.test(text)) add("atlassian", "atlassian");
  // Zoho Recruit career sites often live on a custom domain; the path gives them away
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)\/jobs\/Careers\b/g)) add("zoho", m[1]);
  for (const { ats, re, group } of URL_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, "gi"))) {
      const slug = m[group]?.match(/^[A-Za-z0-9_.-]+/)?.[0];
      if (slug && !RESERVED_SLUG.test(slug)) add(ats, slug);
    }
  }
  // career-site platforms on the employer's own domain: the board IS the page's host, and
  // its assets give the platform away. Last, so a linked ATS board (richer) wins.
  const pageHost = pageUrl?.match(/^https?:\/\/([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  if (pageHost && /\bjibecdn\.com\//i.test(text)) add("jibe", pageHost);
  if (pageHost && /\btbcdn\.talentbrew\.com\//i.test(text)) add("talentbrew", pageHost);
  // a Teamtailor career site on the company's own domain (jobs.lunar.app) serves the same
  // jobs.rss; its assets come from teamtailor-cdn.com
  if (pageHost && !pageHost.endsWith(".teamtailor.com") && /\bteamtailor-cdn\.com\//i.test(text)) add("teamtailor", pageHost);
  return out;
}

/** Confirm a (ats, slug) pair actually returns jobs — turns a guess into confirmed. */
async function probe(ats: AtsType, slug: string): Promise<boolean> {
  switch (ats) {
    case "greenhouse": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    case "lever": {
      const r = await httpJson<unknown[]>(
        `https://api.lever.co/v0/postings/${slug.toLowerCase()}?mode=json&limit=1`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r);
    }
    case "ashby": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    case "workable": {
      const r = await httpJson<{ jobs?: unknown[] }>(
        `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=false`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.jobs);
    }
    case "smartrecruiters": {
      const r = await httpJson<{ totalFound?: number }>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`,
        { timeoutMs: 12_000 },
      );
      return (r?.totalFound ?? 0) > 0; // unknown ids answer 200 with zero postings
    }
    case "workday": {
      const t = parseWorkdaySlug(slug);
      if (!t) return false;
      const r = await httpJson<{ jobPostings?: unknown[] }>(`https://${t.host}/wday/cxs/${t.tenant}/${t.site}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
        timeoutMs: 15_000,
      });
      return Array.isArray(r?.jobPostings);
    }
    case "eightfold": {
      const s = parseEightfoldSlug(slug);
      if (!s) return false;
      const { host, domain } = s;
      if (s.api === "v2") {
        const v2 = await httpJson<{ positions?: unknown[] }>(`https://${host}/api/apply/v2/jobs?domain=${domain}&location=&start=0&num=1`, { timeoutMs: 15_000 });
        return Array.isArray(v2?.positions);
      }
      const r = await httpJson<{ data?: { positions?: unknown[] } }>(
        `https://${host}/api/pcsx/search?domain=${domain}&query=&location=&start=0&num=1`,
        { timeoutMs: 15_000 },
      );
      return Array.isArray(r?.data?.positions);
    }
    case "jibe": {
      const r = await httpJson<{ jobs?: unknown[]; totalCount?: number }>(`https://${slug}/api/jobs?page=1&limit=1`, { timeoutMs: 15_000 });
      return Array.isArray(r?.jobs) && typeof r?.totalCount === "number";
    }
    case "talentbrew": {
      const r = await httpJson<{ results?: string }>(`https://${slug}/search-jobs/results?${talentBrewQuery(1, undefined, 1)}`, { timeoutMs: 15_000 });
      return typeof r?.results === "string" && /data-total-results="/.test(r.results);
    }
    case "recruitee": {
      const r = await httpJson<{ offers?: unknown[] }>(`https://${slug}.recruitee.com/api/offers/`, { timeoutMs: 12_000 });
      return Array.isArray(r?.offers);
    }
    case "personio": {
      // an unknown subdomain answers 404; a live one an XML <workzag-jobs> document
      const host = personioHost(slug);
      const xml = host ? await httpText(`https://${host}/xml`, { timeoutMs: 15_000 }) : null;
      return !!xml && /<workzag-jobs\b/.test(xml);
    }
    case "teamtailor": {
      const host = teamtailorHost(slug);
      const rss = host ? await httpText(`https://${host}/jobs.rss`, { timeoutMs: 12_000 }) : null;
      return !!rss && /<rss\b/.test(rss) && /teamtailor/i.test(rss.slice(0, 600));
    }
    case "bamboohr": {
      // an unknown subdomain 302s to bamboohr.com (no JSON) — don't follow it
      const r = await httpJson<{ result?: unknown[] }>(`https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`, { timeoutMs: 12_000, redirect: "manual" });
      return Array.isArray(r?.result);
    }
    case "breezy": {
      const r = await httpJson<unknown[]>(`https://${encodeURIComponent(slug)}.breezy.hr/json`, { timeoutMs: 12_000 });
      return Array.isArray(r);
    }
    case "oracle": {
      const [host, site] = slug.split("/");
      const finder = encodeURIComponent(`findReqs;siteNumber=${site},limit=1`);
      const r = await httpJson<{ items?: Array<{ TotalJobsCount?: number }> }>(
        `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=${finder}`,
        { timeoutMs: 20_000 },
      );
      return typeof r?.items?.[0]?.TotalJobsCount === "number";
    }
    case "rippling": {
      const r = await httpJson<{ items?: unknown[] }>(
        `https://api.rippling.com/platform/api/ats/v2/board/${encodeURIComponent(slug)}/jobs?page=0&pageSize=1`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.items);
    }
    case "kula": {
      const r = await httpJson<{ data?: unknown[] }>(
        `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(slug)}&type=ats_job_post.index&items=1&page=1`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.data);
    }
    case "zoho": {
      const r = await httpJson<{ data?: unknown[] }>(
        `https://${slug}/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite`,
        { timeoutMs: 12_000 },
      );
      return Array.isArray(r?.data);
    }
    case "keka": {
      const html = await httpText(`https://${slug}.keka.com/careers/`, { timeoutMs: 12_000 });
      return !!html && /\/ats\/documents\/[0-9a-f-]{36}\//i.test(html);
    }
    case "jobvite": {
      const html = await httpText(`https://jobs.jobvite.com/${slug}/jobs`, { timeoutMs: 12_000 });
      return !!html && /companyEId\s*[:=]/.test(html);
    }
    case "freshteam": {
      const body = await httpText(`https://${slug}.freshteam.com/hire/widgets/jobs.json`, { timeoutMs: 12_000 });
      return !!body && body.trimStart().startsWith("{"); // a dead account answers 200 HTML
    }
    case "amazon":
    case "atlassian":
      return true; // single well-known boards; nothing to resolve
    case "darwinbox":
      // NEVER probed from here: Cloudflare blocks non-browser clients, and this code runs
      // in the cloud, which must not touch a local-only board (invariant #1). A
      // {tenant}.darwinbox.in URL names the board outright; the local agent's first poll
      // is the real check (an empty/blocked fetch just returns no postings).
      return true;
    default:
      return false;
  }
}

/** Extract ats+slug from a careers URL via pattern, then confirm it. */
export async function detectFromUrl(url: string): Promise<DetectResult> {
  const first = atsCandidates(url)[0];
  if (!first) return { atsType: "unknown", atsSlug: null, confidence: "none" };
  const confirmed = await confirmSlug(first.ats, first.slug);
  return { atsType: first.ats, atsSlug: confirmed ?? first.slug, confidence: confirmed ? "confirmed" : "guessed" };
}

/**
 * Probe a candidate; an Eightfold tenant still on the older API refuses PCSX (403), so
 * that one retries as its "…/v2" slug — the URL alone can't tell the two apart.
 */
async function confirmSlug(ats: AtsType, slug: string): Promise<string | null> {
  if (await probe(ats, slug).catch(() => false)) return slug;
  if (ats === "eightfold" && parseEightfoldSlug(slug)?.api === "pcsx") {
    const legacy = `${slug}/v2`;
    if (await probe(ats, legacy).catch(() => false)) return legacy;
  }
  return null;
}

/**
 * When we only have a company name (the common case from aggregators/HN), generate
 * candidate slugs and probe the big three ATSes. First confirmed hit wins.
 */
export async function detectFromName(companyName: string): Promise<DetectResult> {
  const candidates = slugCandidates(companyName);
  // probe greenhouse → ashby → lever (richness order), candidates in order
  const order: AtsType[] = ["greenhouse", "ashby", "lever"];
  for (const slug of candidates) {
    for (const ats of order) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probe(ats, slug).catch(() => false);
      if (ok) return { atsType: ats, atsSlug: slug, confidence: "confirmed" };
    }
  }
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}

export function slugCandidates(name: string): string[] {
  const base = slugify(name);
  const compact = base.replace(/-/g, "");
  const noInc = base.replace(/-?(inc|llc|ltd|technologies|labs|hq)$/g, "");
  return [...new Set([base, compact, noInc, noInc.replace(/-/g, "")])].filter(Boolean);
}

/**
 * A careers page on the company's own domain usually embeds or links its ATS
 * (an iframe, an "apply" link, a script src). One polite fetch of the page and a
 * scan for known ATS hosts beats guessing slugs — and it finds boards whose slug
 * isn't the company name (e.g. "razorpaysoftwareprivatelimited").
 */
export async function detectFromCareersPage(url: string): Promise<DetectResult> {
  // "compatible" UA + HTML Accept: many careers sites serve a bare API client an empty
  // shell. One read of a public page, not a crawl.
  const html = (
    await httpText(url, {
      timeoutMs: 12_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobFlow/0.1; +personal job-search)", Accept: "text/html,application/xhtml+xml" },
    })
  )?.slice(0, 2_000_000);
  if (!html) return { atsType: "unknown", atsSlug: null, confidence: "none" };
  let tried = 0;
  for (const { ats, slug } of atsCandidates(html, url)) {
    if (tried++ >= 6) break;
    const confirmed = await confirmSlug(ats, slug);
    if (confirmed) return { atsType: ats, atsSlug: confirmed, confidence: "confirmed" };
  }
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}

export async function detect(input: { url?: string | null; name?: string }): Promise<DetectResult> {
  if (input.url) {
    const byUrl = await detectFromUrl(input.url);
    if (byUrl.atsType !== "unknown") return byUrl;
    const byPage = await detectFromCareersPage(input.url).catch(() => null);
    if (byPage && byPage.atsType !== "unknown") return byPage;
  }
  if (input.name) return detectFromName(input.name);
  return { atsType: "unknown", atsSlug: null, confidence: "none" };
}
