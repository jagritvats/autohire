import type { RawPosting } from "@jobflow/core";
import { httpJson, type FetchTarget, type SourceAdapter } from "../types.js";
import { highlightedToText } from "./text.js";

/**
 * Careerjet (Tier 1, documented publisher API, key-gated) — a job-search engine that
 * crawls Indian boards and employer sites; locale en_IN = the careerjet.co.in index.
 * Verified against the partner docs 2026-09 (the old `affid` endpoint is superseded):
 *   GET https://search.api.careerjet.net/v4/query?locale_code=en_IN&keywords&location
 *       &sort=date&page(1-10)&page_size(≤100)&fragment_size&user_ip&user_agent
 *   Authorization: Basic base64("<API key>:")   — 401 without it
 * `user_ip`/`user_agent` are mandatory (403 without): they identify whoever triggered
 * the search — here the owner, via CAREERJET_USER_IP. Jobs carry no id, `url` is a
 * jobviewtrack.com redirect and `description` a fragment; `date` is Careerjet's
 * crawl/listing date. Without CAREERJET_API_KEY this returns [] before any network call.
 */

export interface CareerjetJob {
  title?: string;
  company?: string;
  date?: string;
  description?: string;
  locations?: string;
  salary?: string;
  salary_currency_code?: string;
  salary_min?: number;
  salary_max?: number;
  /** Y yearly | M monthly | W weekly | D daily | H hourly */
  salary_type?: string;
  url?: string;
  site?: string;
}
export interface CareerjetResponse {
  /** "JOBS", or "LOCATIONS" when the location was ambiguous/unknown (no search ran) */
  type?: string;
  hits?: number;
  pages?: number;
  jobs?: CareerjetJob[];
}

const UA = "JobFlow/0.1 (+personal job-search; contact via app)";
const PAGE_SIZE = 50;

export function hasCareerjetKey(): boolean {
  return !!process.env.CAREERJET_API_KEY;
}

export class CareerjetAdapter implements SourceAdapter {
  readonly source = "careerjet" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    if (!hasCareerjetKey()) return []; // key-gated: no key, no request
    const auth = `Basic ${Buffer.from(`${process.env.CAREERJET_API_KEY}:`).toString("base64")}`;
    const locale = String(target.params?.locale ?? "en_IN");
    const limit = target.limit ?? PAGE_SIZE;
    const out: RawPosting[] = [];
    for (let page = 1; out.length < limit && page <= Math.min(10, Math.ceil(limit / PAGE_SIZE)); page++) {
      const qs = new URLSearchParams({
        locale_code: locale,
        keywords: target.query ?? "backend developer",
        sort: "date",
        page: String(page),
        page_size: String(Math.min(PAGE_SIZE, limit)),
        fragment_size: "500",
        user_ip: process.env.CAREERJET_USER_IP || "127.0.0.1",
        user_agent: UA,
      });
      if (target.location) qs.set("location", target.location);
      if (target.params?.contractType) qs.set("contract_type", String(target.params.contractType));
      if (target.params?.workHours) qs.set("work_hours", String(target.params.workHours));
      const data = await httpJson<CareerjetResponse>(`https://search.api.careerjet.net/v4/query?${qs}`, {
        headers: { Authorization: auth },
      });
      const batch = parseCareerjetResponse(data, locale);
      out.push(...batch);
      if (batch.length < PAGE_SIZE || page >= (data?.pages ?? 0)) break;
    }
    return out.slice(0, limit);
  }
}

/** Map a Careerjet v4 response to raw postings (pure; exported for fixture tests). */
export function parseCareerjetResponse(data: CareerjetResponse | null, locale = "en_IN"): RawPosting[] {
  if (data?.type !== "JOBS") return []; // location mode / error: nothing was searched
  const inIndia = /_IN$/i.test(locale);
  const out: RawPosting[] = [];
  for (const j of data.jobs ?? []) {
    const title = highlightedToText(j.title);
    const company = j.company?.trim() || "";
    if (!title || !j.url) continue;
    const place = j.locations?.trim() ?? "";
    out.push({
      source: "careerjet",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: careerjetId(company, title, place),
      companyName: company || "Unknown",
      companySlug: null,
      title,
      jdText: highlightedToText(j.description),
      jdHtml: null,
      locationRaw: careerjetLocation(place, inIndia),
      applyUrl: j.url,
      salaryRaw: careerjetSalary(j),
      postedAt: j.date && Number.isFinite(Date.parse(j.date)) ? new Date(j.date).toISOString() : null,
      fetchedAt: new Date(),
      raw: { ...j, description: undefined } as unknown as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Careerjet gives no job id and its `url` is a tracking redirect that may carry per-request
 * tokens, so the id is a hash of what identifies the opening (company + title + place):
 * re-polls upsert the same row (invariant #5) instead of inserting a duplicate per call.
 */
function careerjetId(company: string, title: string, place: string): string {
  const key = `${company}|${title}|${place}`.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `cj-${(h >>> 0).toString(36)}-${key.length}`;
}

/** Name the country (en_IN is India-only) so the parse is certain; keep remote explicit. */
function careerjetLocation(place: string, inIndia: boolean): string | null {
  if (!inIndia) return place || null;
  if (!place) return "India";
  const REMOTE = /\b(remote|work from home|wfh|anywhere)\b/i;
  const withCountry = (p: string) => (/\bindia\b/i.test(p) ? p : `${p}, India`);
  if (!REMOTE.test(place)) return withCountry(place);
  const rest = place
    .replace(new RegExp(REMOTE.source, "gi"), " ")
    .replace(/^[\s,;/()-]+|[\s,;/()-]+$/g, "")
    .replace(/\s+/g, " ");
  return `Remote - ${rest ? withCountry(rest) : "India"}`;
}

/**
 * Structured pay only, annualised: yearly as-is, monthly ×12. Weekly/daily/hourly rates
 * are skipped — annualising them is a guess, and a stated salary is parsed with high
 * confidence, which the salary floor may hard-exclude on (invariant #4). The free-text
 * `salary` string is deliberately not used: it doesn't say which period it is.
 */
function careerjetSalary(j: CareerjetJob): string | null {
  const cur = j.salary_currency_code?.toUpperCase();
  if (!cur || !["INR", "USD", "EUR", "GBP"].includes(cur)) return null;
  const mult = j.salary_type === "Y" ? 1 : j.salary_type === "M" ? 12 : 0;
  if (!mult) return null;
  const min = j.salary_min && j.salary_min > 0 ? Math.round(j.salary_min * mult) : null;
  const max = j.salary_max && j.salary_max > 0 ? Math.round(j.salary_max * mult) : null;
  if (min == null && max == null) return null;
  if (min != null && max != null && max !== min) return `${cur} ${min} - ${max}`;
  return `${cur} ${min ?? max}`;
}
