import { LevelBandOrder, type LevelBand, type RawPosting } from "@jobflow/core";
import { htmlToText, httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * Himalayas (Tier 1, free, no auth) — remote board with STRUCTURED geo: every job lists
 * `locationRestrictions`, so "remote, India-eligible" is a query, not a guess (§11.3).
 * Verified live 2026-09:
 *   GET https://himalayas.app/jobs/api/search?q=backend&country=IN&exclude_worldwide=true&sort=recent&page=N
 * 20 per page; `pubDate`/`expiryDate` are epoch seconds; `seniority` is an array
 * ("Entry-level", "Mid-level", "Senior", …) and filterable server-side (comma list).
 * Terms: link back to the listing (we keep `applicationLink`), don't resubmit elsewhere.
 */

interface HimalayasJob {
  title: string;
  companyName: string;
  companySlug?: string;
  description?: string;
  excerpt?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  seniority?: string[];
  locationRestrictions?: string[];
  pubDate?: number;
  expiryDate?: number;
  applicationLink?: string;
  guid: string;
}
interface HimalayasResponse {
  totalCount?: number;
  jobs?: HimalayasJob[];
}

const PAGE_SIZE = 20;

export class HimalayasAdapter implements SourceAdapter {
  readonly source = "himalayas" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const limit = target.limit ?? 40;
    const params = new URLSearchParams({ sort: "recent" });
    if (target.query) params.set("q", target.query);
    const country = String(target.params?.country ?? "IN");
    if (country) {
      params.set("country", country);
      // "worldwide" jobs are fetched by other boards; here we want roles that NAME the country
      params.set("exclude_worldwide", String(target.params?.excludeWorldwide ?? true));
    }
    if (target.params?.seniority) params.set("seniority", String(target.params.seniority));

    const out: RawPosting[] = [];
    for (let page = 1; out.length < limit && page <= Math.ceil(limit / PAGE_SIZE); page++) {
      params.set("page", String(page));
      const data = await httpJson<HimalayasResponse>(`https://himalayas.app/jobs/api/search?${params}`);
      const jobs = data?.jobs ?? [];
      for (const j of jobs) {
        if (j.expiryDate && j.expiryDate * 1000 < Date.now()) continue; // expired listing
        out.push(toRaw(j));
      }
      if (jobs.length < PAGE_SIZE) break;
    }
    return out.slice(0, limit);
  }
}

function toRaw(j: HimalayasJob): RawPosting {
  const restrictions = j.locationRestrictions ?? [];
  const salaryRaw =
    j.minSalary != null && j.currency ? `${j.currency} ${j.minSalary}${j.maxSalary ? ` - ${j.maxSalary}` : ""}` : null;
  // seniority is structured here — prepend it so the title/level parse sees it
  const level = j.seniority?.[0];
  return {
    source: "himalayas",
    tier: "tier1",
    atsType: "unknown",
    atsJobId: j.guid,
    companyName: j.companyName,
    companySlug: null,
    title: j.title,
    jdText: `${level ? `Seniority: ${level}\n` : ""}${htmlToText(j.description) || j.excerpt || ""}`,
    jdHtml: j.description ?? null,
    locationRaw: `Remote${restrictions.length ? ` - ${restrictions.join("; ")}` : " - Worldwide"}`,
    applyUrl: j.applicationLink ?? j.guid,
    salaryRaw,
    postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
    levelHint: himalayasLevel(j.seniority),
    fetchedAt: new Date(),
    raw: { ...j, description: undefined } as unknown as Record<string, unknown>,
  };
}

const HIMALAYAS_LEVELS: Record<string, LevelBand> = {
  "entry-level": "junior",
  "mid-level": "mid",
  senior: "senior",
  manager: "manager",
  director: "director",
  executive: "director",
};

/** A multi-bucket listing ("Mid-level", "Senior") is open to the lowest bucket. */
function himalayasLevel(seniority: string[] | undefined): LevelBand | null {
  const bands = (seniority ?? []).map((s) => HIMALAYAS_LEVELS[s.toLowerCase()]).filter((b): b is LevelBand => !!b);
  if (!bands.length) return null;
  return bands.reduce((lo, b) => (LevelBandOrder[b] < LevelBandOrder[lo] ? b : lo));
}
