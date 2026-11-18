import type { LevelBand, RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Workable public widget API (Tier 1, free, no auth):
 *   GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
 * Shape verified 2026-11: location is TOP-LEVEL (`country`/`city`/`state`) plus a
 * `locations[]` array, and a multi-city job is listed ONCE PER CITY under the same
 * shortcode (Mindera: 76 rows, 36 jobs) — rows are folded by shortcode. `published_on`
 * is bumped when a job is re-published (an evergreen req created 2025-07 showed
 * published_on 2026-11), so a much older `created_at` wins (§3 freshness).
 * Workable's Cloudflare answers bursts with 429 (error 1015) — the adapter degrades to [].
 */

export interface WkLocation {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  region?: string | null;
  hidden?: boolean;
}
export interface WkJob {
  shortcode?: string;
  id?: string;
  title: string;
  description?: string;
  full_description?: string;
  /** older payloads nested the place; current ones put it top-level + `locations` */
  location?: { city?: string; country?: string; region?: string };
  country?: string | null;
  city?: string | null;
  state?: string | null;
  locations?: WkLocation[];
  telecommuting?: boolean;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  experience?: string | null;
  employment_type?: string | null;
  department?: string | null;
}
interface WkResponse {
  name?: string;
  jobs?: WkJob[];
  results?: WkJob[];
}

/** a re-publish more than this long after creation is a repost, not a new role */
const REPUBLISH_GAP_MS = 30 * 86_400_000;

export class WorkableAdapter implements SourceAdapter {
  readonly source = "workable" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = target.slug;
    if (!slug) return [];
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
    const data = await httpJson<WkResponse>(url);
    const jobs = data?.jobs ?? data?.results;
    if (!jobs?.length) return [];
    return parseWorkableJobs(jobs, slug, data?.name);
  }
}

/** Widget rows → RawPostings, one per shortcode with every city merged (pure; exported for tests). */
export function parseWorkableJobs(jobs: WkJob[], slug: string, companyName?: string): RawPosting[] {
  const groups = new Map<string, WkJob[]>();
  for (const j of jobs) {
    const id = j.shortcode ?? j.id;
    if (!id || !j.title?.trim()) continue;
    groups.set(id, [...(groups.get(id) ?? []), j]);
  }
  const out: RawPosting[] = [];
  for (const [id, rows] of groups) {
    const j = rows.find((r) => r.full_description || r.description) ?? rows[0]!;
    const places = [
      ...new Set(
        rows.flatMap((r) => {
          const locs: WkLocation[] = r.locations?.length
            ? r.locations.filter((l) => !l.hidden)
            : [{ city: r.city ?? r.location?.city, region: r.state ?? r.location?.region, country: r.country ?? r.location?.country }];
          return locs.map((l) => [l.city, l.region, l.country].filter((x) => x && String(x).trim()).join(", ")).filter(Boolean);
        }),
      ),
    ];
    const remote = rows.some((r) => r.telecommuting);
    const html = j.full_description ?? j.description ?? null;
    out.push({
      source: "workable",
      tier: "tier1",
      atsType: "workable",
      atsJobId: id,
      companyName: companyName?.trim() || slug,
      companySlug: slug,
      title: j.title.trim(),
      jdText: htmlToText(html),
      jdHtml: html,
      locationRaw: places.length ? `${remote ? "Remote - " : ""}${places.join("; ")}` : remote ? "Remote" : null,
      applyUrl: j.url ?? j.shortlink ?? j.application_url ?? `https://apply.workable.com/${slug}/j/${id}/`,
      salaryRaw: null,
      postedAt: workablePosted(j.published_on, j.created_at),
      levelHint: WK_LEVELS[(j.experience ?? "").toLowerCase()] ?? null,
      fetchedAt: new Date(),
      raw: { shortcode: id, department: j.department, experience: j.experience, employment: j.employment_type } as Record<string, unknown>,
    });
  }
  return out;
}

/** `published_on`, unless the job was created well before it (a re-publish) — then `created_at`. */
export function workablePosted(published: string | undefined, created: string | undefined): string | null {
  const p = published ? Date.parse(published) : NaN;
  const c = created ? Date.parse(created) : NaN;
  if (Number.isFinite(p) && Number.isFinite(c) && p - c > REPUBLISH_GAP_MS) return new Date(c).toISOString();
  if (Number.isFinite(p)) return new Date(p).toISOString();
  return Number.isFinite(c) ? new Date(c).toISOString() : null;
}

/** Workable experience buckets (LinkedIn's); "Mid-Senior level" is ambiguous → no hint. */
const WK_LEVELS: Record<string, LevelBand> = {
  internship: "intern",
  "entry level": "junior",
  associate: "junior",
  director: "director",
  executive: "director",
};
