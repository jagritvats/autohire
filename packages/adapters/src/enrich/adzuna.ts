import type { RoleArchetype } from "@jobflow/core";
import { httpJson } from "../types.js";

/**
 * Adzuna salary benchmark (Tier 1, free tier, country-aware incl. India §11.4). Gated on
 * ADZUNA_APP_ID/ADZUNA_APP_KEY — returns null without keys and the estimator simply has
 * one source fewer.
 *
 * Level-aware: the query carries the seniority word ("senior backend engineer"), so a
 * junior and a staff role no longer share one market figure.
 *
 * Primary: the salary histogram — the distribution over EVERY matching ad, not one page:
 *   GET /v1/api/jobs/{country}/histogram?what=…  →  { histogram: { "<bucket floor>": "<count>" } }
 * Fallback: one page of search results, using only ads that state pay
 * (`salary_is_predicted: "0"` — Adzuna's own predictions are a model's guess, not a sample).
 */

/** SalaryMarket → Adzuna country code + the currency its figures are in (annual). */
export const ADZUNA_MARKET: Readonly<Record<string, { code: string; currency: string }>> = {
  IN: { code: "in", currency: "INR" },
  US: { code: "us", currency: "USD" },
  GB: { code: "gb", currency: "GBP" },
  EU: { code: "de", currency: "EUR" },
  CA: { code: "ca", currency: "CAD" },
  SG: { code: "sg", currency: "SGD" },
  AU: { code: "au", currency: "AUD" },
};

const ARCHETYPE_QUERY: Record<RoleArchetype, string> = {
  backend: "backend engineer",
  platform: "platform engineer",
  infra_devops: "devops engineer",
  sre: "site reliability engineer",
  fullstack: "full stack engineer",
  frontend: "frontend engineer",
  mobile: "mobile engineer",
  data_ml: "machine learning engineer",
  data_analytics: "data analyst",
  other: "software engineer",
};

/** Ladder index → the word recruiters put in titles at that level (none for mid). */
const LEVEL_WORD = ["intern", "junior", "", "senior", "staff", "principal", "director"];

export interface AdzunaSalary {
  median: number;
  p25: number;
  p75: number;
  currency: string;
  sampleCount: number;
  source: "adzuna";
  /** "histogram" (all ads) or "search" (one page of stated-pay ads) */
  method: "histogram" | "search";
  query: string;
}

interface HistogramResp {
  histogram?: Record<string, string | number>;
}
interface SearchResp {
  count?: number;
  results?: Array<{ salary_min?: number; salary_max?: number; salary_is_predicted?: string | number }>;
}

export function hasAdzunaKeys(): boolean {
  return !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

export function adzunaQuery(archetype: RoleArchetype, level: number | null): string {
  const word = level == null ? "" : (LEVEL_WORD[Math.max(0, Math.min(6, level))] ?? "");
  return `${word} ${ARCHETYPE_QUERY[archetype] ?? "software engineer"}`.trim();
}

export async function fetchAdzunaSalary(
  market: string,
  archetype: RoleArchetype,
  level: number | null,
): Promise<AdzunaSalary | null> {
  if (!hasAdzunaKeys()) return null;
  const m = ADZUNA_MARKET[market];
  if (!m) return null; // no Adzuna country for this market (e.g. REMOTE) — never default to US
  const what = adzunaQuery(archetype, level);
  const base = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID!,
    app_key: process.env.ADZUNA_APP_KEY!,
    what,
    "content-type": "application/json",
  });

  const hist = await httpJson<HistogramResp>(`https://api.adzuna.com/v1/api/jobs/${m.code}/histogram?${base}`);
  const fromHist = hist?.histogram ? summarizeHistogram(hist.histogram) : null;
  if (fromHist && fromHist.n >= 8) {
    return { median: fromHist.p50, p25: fromHist.p25, p75: fromHist.p75, currency: m.currency, sampleCount: fromHist.n, source: "adzuna", method: "histogram", query: what };
  }

  base.set("results_per_page", "50");
  const data = await httpJson<SearchResp>(`https://api.adzuna.com/v1/api/jobs/${m.code}/search/1?${base}`);
  const pays: number[] = [];
  for (const r of data?.results ?? []) {
    if (String(r.salary_is_predicted ?? "1") !== "0") continue;
    if (r.salary_min && r.salary_max) pays.push(Math.sqrt(r.salary_min * r.salary_max));
    else if (r.salary_min) pays.push(r.salary_min);
  }
  if (pays.length < 4) return null;
  pays.sort((a, b) => a - b);
  return {
    median: Math.round(percentile(pays, 0.5)),
    p25: Math.round(percentile(pays, 0.25)),
    p75: Math.round(percentile(pays, 0.75)),
    currency: m.currency,
    sampleCount: pays.length,
    source: "adzuna",
    method: "search",
    query: what,
  };
}

/**
 * Percentiles from Adzuna's histogram. Keys are bucket FLOORS; a bucket's width is the gap
 * to the next floor (the last bucket reuses the previous width). Linear within a bucket.
 */
export function summarizeHistogram(h: Record<string, string | number>): { p25: number; p50: number; p75: number; n: number } | null {
  const buckets = Object.entries(h)
    .map(([k, v]) => ({ floor: Number(k), count: Number(v) }))
    .filter((b) => Number.isFinite(b.floor) && b.floor >= 0 && Number.isFinite(b.count) && b.count > 0)
    .sort((a, b) => a.floor - b.floor);
  if (!buckets.length) return null;
  const n = buckets.reduce((s, b) => s + b.count, 0);
  const width = (i: number): number => {
    const next = buckets[i + 1];
    if (next) return next.floor - buckets[i]!.floor;
    const prev = buckets[i - 1];
    return prev ? buckets[i]!.floor - prev.floor : Math.max(1, buckets[i]!.floor * 0.25);
  };
  const at = (q: number): number => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      if (acc + b.count >= target) return Math.round(b.floor + ((target - acc) / b.count) * width(i));
      acc += b.count;
    }
    const last = buckets.length - 1;
    return Math.round(buckets[last]!.floor + width(last));
  };
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75), n };
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
