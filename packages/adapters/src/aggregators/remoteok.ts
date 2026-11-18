import type { RawPosting, SearchQuery } from "@jobflow/core";
import { cleanTitle, htmlToText, httpJson, type FetchTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { queryTerms, slugifyTerm } from "../search.js";

/**
 * Remote OK (Tier 1: the public JSON API, no key). Remote-only board. Verified live 2026-11:
 *   GET https://remoteok.com/api            → [ {legal notice}, …~100 newest jobs ]
 *   GET https://remoteok.com/api?tag=python → the newest jobs with that tag (an unknown tag
 *       silently answers the untagged list — so the query is also applied client-side)
 * API TERMS (element 0 of every response): link back to the job's Remote OK URL and name
 * Remote OK as the source, or access is suspended — so `applyUrl` is ALWAYS the Remote OK
 * listing (never its `apply_url` redirect) and the source is shown as "remoteok". Their
 * dates are when Remote OK listed the job (REDATED_SOURCES caps its freshness). No
 * per-job "gone" endpoint (a missing slug 301s elsewhere), so no isLive — expired items
 * age out via the feed TTL sweep.
 */

export interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  epoch?: string | number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number | string;
  salary_max?: number | string;
  url?: string;
  apply_url?: string;
  legal?: string;
}

export class RemoteOkAdapter implements SourceAdapter {
  readonly source = "remoteok" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: false, remote: true, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /** remote-only board: one target per term (a tag), nothing for an on-site-only search. */
  toTargets(q: SearchQuery, _ctx: SearchTargetContext): FetchTarget[] {
    if (q.remote === "exclude") return [];
    return queryTerms(q).map((term) => ({ query: term, limit: 60 }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const tag = target.query ? slugifyTerm(target.query.split(/\s+/).slice(-1)[0] ?? "") : "";
    const data = await httpJson<RemoteOkJob[]>(`https://remoteok.com/api${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
    if (!Array.isArray(data)) return [];
    const out = parseRemoteOk(data, target.query);
    return target.limit ? out.slice(0, target.limit) : out;
  }
}

/** API rows → RawPostings; `query` keeps rows whose title or tags carry every query word. */
export function parseRemoteOk(rows: RemoteOkJob[], query?: string): RawPosting[] {
  const words = (query ?? "").toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1);
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const j of rows) {
    if (j.legal || j.id == null || !j.position?.trim() || !j.company?.trim()) continue; // the terms row
    const id = String(j.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const hay = `${j.position} ${(j.tags ?? []).join(" ")}`.toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    const lo = Number(j.salary_min);
    const hi = Number(j.salary_max);
    const t = j.date ? Date.parse(j.date) : Number(j.epoch) * 1000;
    out.push({
      source: "remoteok",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: id,
      companyName: cleanTitle(j.company),
      companySlug: null,
      title: cleanTitle(j.position),
      jdText: htmlToText(j.description),
      jdHtml: j.description ?? null,
      locationRaw: j.location?.trim() && !/^remote$/i.test(j.location.trim()) ? `Remote - ${j.location.trim()}` : "Remote",
      // ToS: link back to the Remote OK listing
      applyUrl: j.url ?? (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : null),
      // Remote OK asks the poster for a yearly USD range
      salaryRaw: lo > 0 && hi > 0 ? `USD ${lo} - ${hi} per year` : lo > 0 ? `USD ${lo} per year` : null,
      postedAt: Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null,
      fetchedAt: new Date(),
      raw: { id, slug: j.slug, tags: j.tags, attribution: "Remote OK" } as Record<string, unknown>,
    });
  }
  return out;
}
