import type { RawPosting, SearchQuery } from "@jobflow/core";
import { httpJson, type FetchTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { expWindow, inIndia, queryTerms } from "../search.js";

/**
 * Hirist.tech (Tier 2: the public JSON its own search page calls, no login) — an
 * India-only tech board with a server-side experience filter, so a ~2-YoE profile can
 * ask for 1–4-year roles instead of wading through senior ones. Verified live 2026-09:
 *   GET https://gladiator.hirist.tech/job/search?query=…&page=N&size=20&minexp=1&maxexp=4   (header version: 2)
 * The list has no JD body — title, company, exp range, skill tags (mandatory flagged),
 * locations and an exact createdTimeMs — so we compose a compact JD from those fields.
 */

interface HiristJob {
  id: number;
  title: string;
  min?: number;
  max?: number;
  jobDetailUrl?: string;
  workFromHome?: number;
  createdTimeMs?: number;
  tags?: Array<{ name: string; isMandatory?: boolean }>;
  locations?: Array<{ name: string }>;
  companyData?: { companyName?: string };
}
interface HiristResponse {
  data?: HiristJob[];
  hasMore?: boolean;
}

/** Hirist/IIMJobs post some roles under their own name, with the employer as a title prefix. */
const PLATFORM_NAMES = /^(hirist(\.tech|\.com)?|iimjobs(\.com)?|updazz)$/i;

export class HiristAdapter implements SourceAdapter {
  readonly source = "hirist" as const;
  readonly tier = "tier2" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: false, remote: false, postedWithin: false, salaryMin: false, seniority: true, cost: "free",
  };

  /** India tech board: India markets only; the experience band is the searcher's own (soft). */
  toTargets(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[] {
    if (!inIndia(q, ctx)) return [];
    const { min, max } = expWindow(ctx.yoe);
    return queryTerms(q).map((term) => ({ query: term, limit: 60, params: { minexp: min, maxexp: max } }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const limit = target.limit ?? 60;
    const out: RawPosting[] = [];
    // the relevance-sorted pages overlap (verified 2026-11: page 2 repeats the tail of page
    // 1) — dedupe, and keep paging until `limit` distinct jobs
    const seen = new Set<number>();
    for (let page = 0; out.length < limit && page < 10; page++) {
      const qs = new URLSearchParams({ query: target.query ?? "backend developer", page: String(page), size: "20" });
      if (target.params?.minexp != null) qs.set("minexp", String(target.params.minexp));
      if (target.params?.maxexp != null) qs.set("maxexp", String(target.params.maxexp));
      const res = await httpJson<HiristResponse>(`https://gladiator.hirist.tech/job/search?${qs}`, {
        headers: { version: "2", Origin: "https://www.hirist.tech", Referer: "https://www.hirist.tech/" },
      });
      const jobs = res?.data ?? [];
      for (const j of jobs) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        out.push(toRaw(j));
      }
      if (!res?.hasMore || jobs.length === 0) break;
    }
    return out.slice(0, limit);
  }
}

function toRaw(j: HiristJob): RawPosting {
  const listed = j.companyData?.companyName?.trim() ?? "";
  // "DriveX - Backend Developer - Python": the lede is the employer when the listed
  // company is the platform itself, or when it matches the listed company's first word
  const [lede, ...rest] = j.title.split(" - ");
  const ledeIsCompany =
    rest.length > 0 && !!lede && (PLATFORM_NAMES.test(listed) || listed.toLowerCase().startsWith(lede.toLowerCase().split(" ")[0] ?? "\u0000"));
  const company = PLATFORM_NAMES.test(listed) && ledeIsCompany ? lede! : listed || lede || "Unknown";
  const title = ledeIsCompany ? rest.join(" - ") : j.title;

  const tags = j.tags ?? [];
  const must = tags.filter((t) => t.isMandatory).map((t) => t.name);
  const nice = tags.filter((t) => !t.isMandatory).map((t) => t.name);
  const locs = (j.locations ?? []).map((l) => l.name);
  const exp = j.min != null ? `${j.min}${j.max != null ? `-${j.max}` : "+"} years` : "";
  const jd = [
    exp ? `Experience: ${exp}` : "",
    must.length ? `Required: ${must.join(", ")}` : "",
    nice.length ? `Nice to have: ${nice.join(", ")}` : "",
    locs.length ? `Locations: ${locs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    source: "hirist",
    tier: "tier2",
    atsType: "unknown",
    atsJobId: String(j.id),
    companyName: company,
    companySlug: null,
    title,
    jdText: jd,
    jdHtml: null,
    locationRaw: j.workFromHome ? `Remote - India${locs.length ? `; ${locs.join(", ")}` : ""}` : locs.length ? `${locs.join("; ")}, India` : "India",
    applyUrl: j.jobDetailUrl ?? `https://www.hirist.tech/j/${j.id}`,
    // minSal/maxSal units are undocumented — never guess a number the salary floor could
    // hard-exclude on (invariant #4: high-confidence salary only)
    salaryRaw: null,
    postedAt: j.createdTimeMs ? new Date(j.createdTimeMs).toISOString() : null,
    experienceHint: j.min != null ? { min: j.min, max: j.max ?? null } : undefined,
    fetchedAt: new Date(),
    raw: { id: j.id, company: listed } as Record<string, unknown>,
  };
}
