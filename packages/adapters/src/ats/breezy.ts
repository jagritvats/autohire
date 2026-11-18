import type { RawPosting } from "@jobflow/core";
import { DETAIL_CAP, htmlToText, httpJson, httpStatus, httpText, mapPool, pickForDetail, type FetchTarget, type LivenessTarget, type SourceAdapter } from "../types.js";
import { jobPostingLd } from "./talentbrew.js";

/**
 * Breezy HR career portals (Tier 1: the public JSON feed every portal publishes, no auth)
 * — US/EU SMBs. slug = the {slug}.breezy.hr subdomain. Verified live 2026-11:
 *   GET https://{slug}.breezy.hr/json            → [ {id, friendly_id, name, url, published_date, location(s), salary…} ]
 *   GET https://{slug}.breezy.hr/p/{id}          → the job page; its schema.org JobPosting JSON-LD
 *       carries the JD. A position that is gone 302s to the portal root ("/").
 * An unknown portal answers 404 HTML. The list has no JD, so only NEW positions get the
 * page fetch (FetchTarget.known).
 */

export interface BreezyPosition {
  id: string;
  friendly_id?: string;
  name: string;
  url?: string;
  published_date?: string;
  type?: { id?: string; name?: string } | null;
  location?: BreezyLocation | null;
  locations?: BreezyLocation[];
  department?: string | null;
  salary?: string | null;
  company?: { name?: string; friendly_id?: string } | null;
}
interface BreezyLocation {
  name?: string;
  city?: string;
  country?: { id?: string; name?: string } | null;
  state?: { id?: string; name?: string } | null;
  is_remote?: boolean;
}

export class BreezyAdapter implements SourceAdapter {
  readonly source = "breezy" as const;
  readonly tier = "tier1" as const;

  /**
   * The job page: 200 while listed; a removed position 302s to the portal root (the
   * portal's own "no such position" answer — verified 2026-11 with an unknown id). Any
   * other redirect, error or status = can't tell.
   */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const slug = breezySlug(job.slug);
    if (!slug || !/^[a-z0-9]+$/i.test(job.jobId)) return null;
    const r = await httpStatus(`https://${slug}.breezy.hr/p/${job.jobId}`, { headers: { Accept: "text/html" } });
    if (!r) return null;
    if (r.status === 200) return true;
    if (r.status === 404 || r.status === 410) return false;
    if (r.status >= 300 && r.status < 400) return breezyGoneRedirect(r.location, slug) ? false : null;
    return null;
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const slug = breezySlug(target.slug);
    if (!slug) return [];
    const list = await httpJson<BreezyPosition[]>(`https://${slug}.breezy.hr/json`);
    if (!Array.isArray(list)) return [];

    const needDetail = pickForDetail(list.filter((p) => !target.known?.has(p.id)), (p) => p.name, target.limit ?? DETAIL_CAP);
    const jds = new Map<string, string>();
    await mapPool(needDetail, 3, async (p) => {
      const html = await httpText(`https://${slug}.breezy.hr/p/${p.id}`, { headers: { Accept: "text/html" } });
      const ld = html ? jobPostingLd(html) : null;
      if (ld?.description) jds.set(p.id, ld.description);
    });
    return parseBreezyPositions(list, jds, slug);
  }
}

/** a removed position redirects to the portal root — nothing else counts as "gone". */
export function breezyGoneRedirect(location: string | null, slug: string): boolean {
  if (!location) return false;
  return location === "/" || location.replace(/\/+$/, "").toLowerCase() === `https://${slug}.breezy.hr`;
}

function breezySlug(s: string | null | undefined): string | null {
  const slug = (s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[./]/)[0] ?? "";
  return /^[a-z0-9-]+$/.test(slug) ? slug : null;
}

/** Breezy positions (+ any JDs fetched) → RawPostings (pure; exported for fixture tests). */
export function parseBreezyPositions(list: BreezyPosition[], jds: ReadonlyMap<string, string>, slug: string): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const p of list) {
    if (!p?.id || !p.name?.trim() || seen.has(p.id)) continue;
    seen.add(p.id);
    const locs = p.locations?.length ? p.locations : p.location ? [p.location] : [];
    const places = [
      ...new Set(
        locs
          .map((l) => [l.city, l.state?.name, l.country?.name].filter(Boolean).join(", ") || l.name || "")
          .filter(Boolean),
      ),
    ];
    const remote = locs.some((l) => l.is_remote);
    const html = jds.get(p.id) ?? null;
    const t = p.published_date ? Date.parse(p.published_date) : NaN;
    out.push({
      source: "breezy",
      tier: "tier1",
      atsType: "breezy",
      atsJobId: p.id,
      companyName: p.company?.name?.trim() || slug,
      companySlug: slug,
      title: p.name.trim(),
      jdText: htmlToText(html),
      jdHtml: html,
      locationRaw: places.length ? `${remote ? "Remote - " : ""}${places.join("; ")}` : remote ? "Remote" : null,
      applyUrl: p.url ?? `https://${slug}.breezy.hr/p/${p.friendly_id ?? p.id}`,
      salaryRaw: p.salary?.trim() || null,
      postedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      fetchedAt: new Date(),
      raw: { id: p.id, type: p.type?.id, department: p.department } as Record<string, unknown>,
    });
  }
  return out;
}
