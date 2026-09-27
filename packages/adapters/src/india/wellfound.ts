import type { RawPosting } from "@jobflow/core";
import { httpText, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Wellfound (Tier 2, fragile: public server-rendered role×location pages, no login to
 * browse) — Indian startups, with the real `liveStartAt` and years-of-experience fields.
 * Verified 2026-09 from a residential IP: plain fetch of
 *   GET https://wellfound.com/role/l/{role}/{location}?page=N
 * returns `__NEXT_DATA__` with an Apollo cache: `JobListingSearchResult:*` jobs and
 * `StartupResult:*` companies (linked via highlightedJobListings). Cloudflare/Turnstile
 * sit in front — from a datacenter IP this may be challenged, and the adapter then just
 * returns what it got. Results aren't date-sorted, so a few pages are read, politely.
 * "**Apply here**: <other site>" listings are third-party reposters and are skipped.
 */

interface WfJob {
  id: string;
  title: string;
  slug?: string;
  description?: string;
  liveStartAt?: number;
  locationNames?: string[];
  remote?: boolean;
  acceptedRemoteLocationNames?: string[];
  yearsExperienceMin?: number | null;
  yearsExperienceMax?: number | null;
  compensation?: string;
  autoPosted?: boolean;
}
interface WfStartup {
  name?: string;
  highlightedJobListings?: Array<{ __ref?: string }>;
}

const REPOSTER = /^\W*apply here\W*:\s*https?:\/\//i;

export class WellfoundAdapter implements SourceAdapter {
  readonly source = "wellfound" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const role = (target.query ?? "backend-engineer").replace(/[^a-z0-9-]/gi, "");
    const where = String(target.params?.location ?? "india").replace(/[^a-z0-9-]/gi, "");
    const maxPages = Number(target.params?.maxPages ?? 5);
    const out = new Map<string, RawPosting>();
    let pageCount = maxPages;
    for (let page = 1; page <= Math.min(maxPages, pageCount); page++) {
      if (page > 1) await sleep(3000); // polite: this is a human-facing site
      const html = await httpText(`https://wellfound.com/role/l/${role}/${where}?page=${page}`, { timeoutMs: 30_000 });
      if (!html) break;
      const parsed = parseWellfoundPage(html);
      if (!parsed) break;
      pageCount = parsed.pageCount ?? pageCount;
      for (const r of parsed.postings) out.set(r.atsJobId, r);
      if (out.size >= (target.limit ?? 150)) break;
    }
    return [...out.values()];
  }
}

export function parseWellfoundPage(html: string): { postings: RawPosting[]; pageCount: number | null } | null {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); // tag carries crossorigin=…
  if (!m?.[1]) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(m[1])?.props?.pageProps?.apolloState?.data ?? {};
  } catch {
    return null;
  }
  const companyOf = new Map<string, string>();
  for (const [key, v] of Object.entries(data)) {
    if (!key.startsWith("StartupResult:")) continue;
    const s = v as WfStartup;
    for (const ref of s.highlightedJobListings ?? []) if (ref.__ref && s.name) companyOf.set(ref.__ref, s.name);
  }
  const pageCount = Number(m[1].match(/"pageCount":(\d+)/)?.[1] ?? NaN);

  const postings: RawPosting[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (!key.startsWith("JobListingSearchResult:")) continue;
    const j = v as WfJob;
    if (!j.id || !j.title || REPOSTER.test(j.description ?? "")) continue;
    const lo = j.yearsExperienceMin;
    const hi = j.yearsExperienceMax;
    const exp = lo != null ? `Experience: ${lo}${hi != null && hi > lo ? `-${hi}` : "+"} years\n` : "";
    const places = (j.remote && j.acceptedRemoteLocationNames?.length ? j.acceptedRemoteLocationNames : j.locationNames) ?? [];
    postings.push({
      source: "wellfound",
      tier: "tier2",
      atsType: "unknown",
      atsJobId: j.id,
      companyName: companyOf.get(key) ?? "Unknown",
      companySlug: null,
      title: j.title.trim(),
      jdText: `${exp}${j.description ?? ""}`,
      jdHtml: null,
      locationRaw: `${j.remote ? "Remote - " : ""}${places.join("; ") || "India"}`,
      applyUrl: `https://wellfound.com/jobs/${j.id}${j.slug ? `-${j.slug}` : ""}`,
      salaryRaw: j.compensation || null,
      postedAt: j.liveStartAt ? new Date(j.liveStartAt * 1000).toISOString() : null,
      experienceHint: lo != null ? { min: lo, max: hi != null && hi >= lo ? hi : null } : undefined,
      fetchedAt: new Date(),
      raw: { id: j.id, autoPosted: !!j.autoPosted } as Record<string, unknown>,
    });
  }
  return { postings, pageCount: Number.isFinite(pageCount) ? pageCount : null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
