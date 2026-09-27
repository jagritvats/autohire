import type { RawPosting } from "@jobflow/core";
import { hasAdzunaKeys } from "../enrich/adzuna.js";
import { httpJson, type FetchTarget, type SourceAdapter } from "../types.js";
import { highlightedToText } from "./text.js";

/**
 * Adzuna job search (Tier 1, documented API, free key) — a broad India aggregator
 * (it indexes Indian boards + employer sites), so it adds volume the curated boards miss.
 * Same keys as the salary enricher (ADZUNA_APP_ID / ADZUNA_APP_KEY); without them this
 * returns [] before any network call. Contract from the published swagger (2026-09):
 *   GET https://api.adzuna.com/v1/api/jobs/in/search/{page}
 *       ?app_id&app_key&what|title_only&max_days_old&sort_by=date&results_per_page≤50
 * `description` is a ≤500-char snippet; `created` is when ADZUNA placed the ad (its own
 * ingest — a board's re-post reads as new); `redirect_url` is Adzuna's tracking hop.
 * Free-tier quota (~250 calls/day) is shared with the enricher, so default feeds stay small.
 */

export interface AdzunaJob {
  id: string | number;
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  /** "1" when Adzuna ESTIMATED the pay (not stated in the ad) */
  salary_is_predicted?: string | number;
  contract_type?: string;
  contract_time?: string;
  category?: { tag?: string; label?: string };
}
export interface AdzunaSearchResponse {
  count?: number;
  results?: AdzunaJob[];
}

const PAGE_SIZE = 50;
/**
 * Adzuna country code → currency its salary figures are in (local currency, annual).
 * Only currencies the core salary parser recognizes — an "SGD …" string would read as USD.
 */
const CURRENCY: Record<string, string> = { in: "INR", us: "USD", gb: "GBP", de: "EUR" };
const COUNTRY: Record<string, string> = { in: "India", us: "United States", gb: "United Kingdom", sg: "Singapore", ca: "Canada", de: "Germany" };

export class AdzunaSearchAdapter implements SourceAdapter {
  readonly source = "adzuna" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    if (!hasAdzunaKeys()) return []; // key-gated: no keys, no request
    const country = String(target.params?.country ?? "in").toLowerCase();
    const limit = target.limit ?? PAGE_SIZE;
    const out: RawPosting[] = [];
    for (let page = 1; out.length < limit && page <= Math.min(5, Math.ceil(limit / PAGE_SIZE)); page++) {
      const qs = new URLSearchParams({
        app_id: process.env.ADZUNA_APP_ID!,
        app_key: process.env.ADZUNA_APP_KEY!,
        results_per_page: String(Math.min(PAGE_SIZE, limit)),
        sort_by: "date",
        max_days_old: String(target.params?.maxDaysOld ?? 14),
        "content-type": "application/json",
      });
      const q = target.query ?? "backend developer";
      qs.set(target.params?.titleOnly ? "title_only" : "what", q);
      if (target.location) qs.set("where", target.location);
      if (target.params?.category) qs.set("category", String(target.params.category));
      const data = await httpJson<AdzunaSearchResponse>(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${qs}`);
      const batch = parseAdzunaResults(data, country);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return out.slice(0, limit);
  }
}

/** Map an Adzuna search response to raw postings (pure; exported for fixture tests). */
export function parseAdzunaResults(data: AdzunaSearchResponse | null, country = "in"): RawPosting[] {
  const out: RawPosting[] = [];
  const countryName = COUNTRY[country] ?? "";
  for (const j of data?.results ?? []) {
    const title = highlightedToText(j.title); // tolerate matched-term highlight markup
    if (!title || j.id == null) continue;
    const place = j.location?.display_name?.trim() ?? "";
    // area is [country, state, city…]; make sure the country is named so the parse is sure of it
    const locationRaw =
      place && countryName && !new RegExp(`\\b${countryName}\\b`, "i").test(place) ? `${place}, ${countryName}` : place || countryName || null;
    const jd = [highlightedToText(j.description), j.contract_type === "contract" ? "Contract role." : ""].filter(Boolean).join("\n");
    out.push({
      source: "adzuna",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: String(j.id),
      companyName: j.company?.display_name?.trim() || "Unknown",
      companySlug: null,
      title,
      jdText: jd,
      jdHtml: null,
      locationRaw,
      applyUrl: j.redirect_url ?? null,
      salaryRaw: adzunaSalary(j, CURRENCY[country]),
      postedAt: j.created ?? null,
      fetchedAt: new Date(),
      raw: { ...j, description: undefined } as unknown as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Only pay the ad itself states. Adzuna fills gaps with its own estimate
 * (`salary_is_predicted: "1"`); that's a model guess, and a stated-salary string here is
 * parsed as high-confidence — which the salary floor may hard-exclude on (invariant #4).
 */
function adzunaSalary(j: AdzunaJob, currency: string | undefined): string | null {
  if (!currency || String(j.salary_is_predicted ?? "1") !== "0") return null;
  const min = j.salary_min && j.salary_min > 0 ? Math.round(j.salary_min) : null;
  const max = j.salary_max && j.salary_max > 0 ? Math.round(j.salary_max) : null;
  if (min == null && max == null) return null;
  if (min != null && max != null && max !== min) return `${currency} ${min} - ${max}`;
  return `${currency} ${min ?? max}`;
}
