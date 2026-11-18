import type { LevelBand, RawPosting } from "@jobflow/core";
import { DETAIL_CAP, htmlToText, httpJson, httpStatus, liveFromStatus, mapPool, pickForDetail, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";

/**
 * BambooHR careers pages (Tier 2: the JSON the public careers page itself calls, no auth)
 * — US/LatAm SMBs. slug = the {slug}.bamboohr.com subdomain. Verified live 2026-11:
 *   GET https://{slug}.bamboohr.com/careers/list          → { meta.totalCount, result[] } every open job, no JD/date
 *   GET https://{slug}.bamboohr.com/careers/{id}/detail   → { result.jobOpening } JD, datePosted, country,
 *       jobOpeningStatus; 404 {"type":"not_found"} once the opening is gone
 * An unknown subdomain answers 302 → bamboohr.com (not JSON), so it degrades to [].
 * The list has no JD, so only NEW openings get the detail call (FetchTarget.known).
 * locationType: "0" on-site, "1" remote, "2" hybrid.
 */

export interface BambooListItem {
  id: string;
  jobOpeningName: string;
  departmentLabel?: string | null;
  employmentStatusLabel?: string | null;
  location?: { city?: string | null; state?: string | null } | null;
  atsLocation?: { country?: string | null; state?: string | null; province?: string | null; city?: string | null } | null;
  isRemote?: boolean | null;
  locationType?: string | null;
}
interface BambooList {
  meta?: { totalCount?: number };
  result?: BambooListItem[];
}
export interface BambooDetail {
  jobOpeningShareUrl?: string;
  jobOpeningName?: string;
  jobOpeningStatus?: string;
  description?: string;
  datePosted?: string | null;
  minimumExperience?: string | null;
  compensation?: string | null;
  location?: { city?: string | null; state?: string | null; addressCountry?: string | null } | null;
  locationType?: string | null;
}

export class BambooHrAdapter implements SourceAdapter {
  readonly source = "bamboohr" as const;
  readonly tier = "tier2" as const;

  /** per-opening detail: 404 not_found once removed; jobOpeningStatus other than "Open" = closed (verified 2026-11) */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const slug = bambooSlug(job.slug);
    if (!slug || !/^\d+$/.test(job.jobId)) return null;
    const r = await httpStatus(`https://${slug}.bamboohr.com/careers/${job.jobId}/detail`);
    if (r?.status !== 200) return liveFromStatus(r);
    try {
      const status = (JSON.parse(r.body) as { result?: { jobOpening?: BambooDetail } }).result?.jobOpening?.jobOpeningStatus;
      return status ? /^open$/i.test(status) : null;
    } catch {
      return null;
    }
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = bambooSlug(target.slug);
    if (!slug) return [];
    const base = `https://${slug}.bamboohr.com/careers`;
    const list = await httpJson<BambooList>(`${base}/list`, { redirect: "manual" });
    if (!Array.isArray(list?.result)) return [];

    const needDetail = pickForDetail(list.result.filter((j) => !target.known?.has(String(j.id))), (j) => j.jobOpeningName, target.limit ?? DETAIL_CAP);
    const details = new Map<string, BambooDetail>();
    await mapPool(needDetail, 3, async (j) => {
      const d = await httpJson<{ result?: { jobOpening?: BambooDetail } }>(`${base}/${encodeURIComponent(j.id)}/detail`);
      if (d?.result?.jobOpening) details.set(String(j.id), d.result.jobOpening);
    });
    return parseBambooJobs(list.result, details, slug);
  }
}

function bambooSlug(s: string | null | undefined): string | null {
  const slug = (s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[./]/)[0] ?? "";
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

/** list rows (+ any details fetched) → RawPostings (pure; exported for fixture tests). */
export function parseBambooJobs(items: BambooListItem[], details: ReadonlyMap<string, BambooDetail>, slug: string): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const j of items) {
    const id = String(j.id ?? "");
    if (!id || !j.jobOpeningName?.trim() || seen.has(id)) continue;
    seen.add(id);
    const d = details.get(id);
    if (d?.jobOpeningStatus && !/^open$/i.test(d.jobOpeningStatus)) continue;
    const loc = d?.location ?? j.location ?? {};
    const country = (d?.location?.addressCountry ?? j.atsLocation?.country ?? null) || null;
    const place = [loc.city, loc.state, country].filter(Boolean).join(", ");
    const type = d?.locationType ?? j.locationType;
    const mode = j.isRemote || type === "1" ? "Remote - " : type === "2" ? "Hybrid - " : "";
    const posted = d?.datePosted ? Date.parse(d.datePosted) : NaN;
    out.push({
      source: "bamboohr",
      tier: "tier2",
      atsType: "bamboohr",
      atsJobId: id,
      companyName: slug,
      companySlug: slug,
      title: j.jobOpeningName.trim(),
      jdText: d ? `${d.minimumExperience ? `Experience level: ${d.minimumExperience}\n` : ""}${htmlToText(d.description)}` : "",
      jdHtml: d?.description ?? null,
      locationRaw: place ? `${mode}${place}` : mode.startsWith("Remote") ? "Remote" : null,
      applyUrl: d?.jobOpeningShareUrl ?? `https://${slug}.bamboohr.com/careers/${id}`,
      salaryRaw: d?.compensation?.trim() || null,
      postedAt: Number.isFinite(posted) ? new Date(posted).toISOString() : null,
      levelHint: BAMBOO_LEVELS[(d?.minimumExperience ?? "").toLowerCase()] ?? null,
      fetchedAt: new Date(),
      raw: { id, department: j.departmentLabel, employment: j.employmentStatusLabel } as Record<string, unknown>,
    });
  }
  return out;
}

/** BambooHR "minimum experience"; "Mid-level"/"Experienced" are left to the title. */
const BAMBOO_LEVELS: Record<string, LevelBand> = {
  "entry-level": "junior",
  "student (college)": "intern",
  "student (high school)": "intern",
  manager: "manager",
  "senior manager/supervisor": "manager",
  "executive": "director",
  "senior executive": "director",
};
