import { LevelBandOrder, type LevelBand, type RawPosting, type SearchQuery } from "@jobflow/core";
import { adapterNotice, htmlToText, httpJsonPolite, httpStatus, liveFromStatus, type FetchTarget, type LivenessTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { crossCapped, queryCountries, queryTerms } from "../search.js";

/**
 * Himalayas (Tier 1, free, no auth) — remote board with STRUCTURED geo: every job lists
 * `locationRestrictions`, so "remote, India-eligible" is a query, not a guess (§11.3).
 * Verified live 2026-09:
 *   GET https://himalayas.app/jobs/api/search?q=backend&country=IN&exclude_worldwide=true&sort=recent&page=N
 * 20 per page; `pubDate`/`expiryDate` are epoch seconds; `seniority` is an array
 * ("Entry-level", "Mid-level", "Senior", …) and filterable server-side (comma list).
 * Terms: link back to the listing (we keep `applicationLink`), don't resubmit elsewhere.
 *
 * Keys (docs: himalayas.app/docs/remote-jobs-api, checked 2026-11-18): every endpoint works
 * without one, but keyless callers share ONE public allowance, and from shared server
 * egress that answers 429 "get a free API key". A free key (`HIMALAYAS_API_KEY`, sent as
 * `Authorization: Bearer …`) gets the account its own 60/min and 10,000/day. A keyed 429
 * carries Retry-After, which `httpJsonPolite` honours. Without a key, a 429 that outlasts
 * the backoff parks the source for this process (RATE_LIMIT_PAUSE_MS) and logs why, so the
 * other preset targets don't each wait out the same limit; the feed degrades to [].
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
/** keyless and rate-limited: skip Himalayas for this long (the data refreshes daily anyway). */
const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
let pausedUntil = 0;

/** test hook: forget a rate-limit pause. */
export function resetHimalayasPause(): void {
  pausedUntil = 0;
}

function apiKey(): string | null {
  return process.env.HIMALAYAS_API_KEY?.trim() || null;
}

export class HimalayasAdapter implements SourceAdapter {
  readonly source = "himalayas" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: true, remote: true, postedWithin: false, salaryMin: false, seniority: true, cost: "free",
  };

  /**
   * Himalayas' documented single-job check: the guid with /jobs/api after the domain →
   * 200 open, 410 closed, 404 no such job (docs, checked live 2026-11-18). Anything else
   * (429, 5xx, a network error) can't tell.
   */
  async isLive(job: LivenessTarget): Promise<boolean | null> {
    const m = job.jobId.match(/^https:\/\/himalayas\.app\/(companies\/[^/?#]+\/jobs\/[^/?#]+)$/);
    if (!m) return null;
    const key = apiKey();
    return liveFromStatus(await httpStatus(`https://himalayas.app/jobs/api/${m[1]}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {}));
  }

  /** remote-only board: one target per (term × country), worldwide-eligible roles included. */
  toTargets(q: SearchQuery, ctx: SearchTargetContext): FetchTarget[] {
    if (q.remote === "exclude") return [];
    const terms = queryTerms(q);
    if (!terms.length) return [];
    const countries = queryCountries(q, ctx);
    const seniority = [...new Set(q.seniority.map((b) => HIMALAYAS_SENIORITY[b]))].join(",");
    return crossCapped(terms, countries.length ? countries : [""]).map(([term, country]) => ({
      query: term,
      limit: 40,
      params: { country, excludeWorldwide: false, ...(seniority ? { seniority } : {}) },
    }));
  }

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

    const key = apiKey();
    if (!key && Date.now() < pausedUntil) return [];
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    let gaveUp: number | null = null;

    const out: RawPosting[] = [];
    for (let page = 1; out.length < limit && page <= Math.ceil(limit / PAGE_SIZE); page++) {
      params.set("page", String(page));
      const data = await httpJsonPolite<HimalayasResponse>(
        `https://himalayas.app/jobs/api/search?${params}`,
        { headers },
        { retries: 2, baseDelayMs: 5000, onGiveUp: (status) => (gaveUp = status) },
      );
      if (!data) {
        explainFailure(gaveUp, !!key);
        break;
      }
      const jobs = data.jobs ?? [];
      for (const j of jobs) {
        if (j.expiryDate && j.expiryDate * 1000 < Date.now()) continue; // expired listing
        out.push(toRaw(j));
      }
      if (jobs.length < PAGE_SIZE) break;
    }
    return out.slice(0, limit);
  }
}

/** a failed page: log the reason once, and park a keyless, rate-limited source. */
function explainFailure(status: number | null, keyed: boolean): void {
  if (status === 429 && !keyed) {
    pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
    adapterNotice("himalayas", "rate-limited (429) without an API key: skipping Himalayas for 15 min. Set HIMALAYAS_API_KEY (free at himalayas.app/api) for a higher allowance.");
  } else if (status === 429) {
    adapterNotice("himalayas", "rate-limited (429) even with HIMALAYAS_API_KEY: the key's 60/min or 10,000/day allowance is used up.");
  } else if (status === 401) {
    adapterNotice("himalayas", "HIMALAYAS_API_KEY was rejected (401: invalid, revoked or unverified). Fix or unset it.");
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

/** our band → Himalayas' server-side seniority bucket. */
const HIMALAYAS_SENIORITY: Record<LevelBand, string> = {
  intern: "Entry-level",
  junior: "Entry-level",
  mid: "Mid-level",
  senior: "Senior",
  staff: "Senior",
  lead: "Senior",
  principal: "Senior",
  manager: "Manager",
  director: "Director",
};

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
