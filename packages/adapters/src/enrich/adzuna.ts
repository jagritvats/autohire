import type { RoleArchetype } from "@jobflow/core";
import { httpJson } from "../types.js";

/**
 * Adzuna salary enrichment (Tier 1, free tier, country-aware incl. India §11.4).
 *   GET https://api.adzuna.com/v1/api/jobs/{country}/search/1
 *       ?app_id=&app_key=&what=&where=&results_per_page=50&content-type=application/json
 * Response: { count, mean, results: [{ salary_min, salary_max, salary_is_predicted }] }.
 * Gated on ADZUNA_APP_ID/ADZUNA_APP_KEY — returns null with no keys (cascade falls
 * through to levels.fyi). Confidence: medium.
 */

interface AdzunaResult {
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string;
}
interface AdzunaResp {
  count: number;
  mean?: number;
  results?: AdzunaResult[];
}

export interface AdzunaSalary {
  min: number;
  max: number;
  currency: string;
  source: "adzuna";
  confidence: "medium";
  sampleCount: number;
}

const ARCHETYPE_QUERY: Record<RoleArchetype, string> = {
  backend: "backend engineer",
  platform: "platform engineer",
  infra_devops: "devops engineer",
  sre: "site reliability engineer",
  fullstack: "full stack engineer",
  frontend: "frontend engineer",
  mobile: "mobile engineer",
  data_ml: "machine learning engineer",
  other: "software engineer",
};

// crude location → Adzuna country code + currency
const COUNTRY: Array<[RegExp, { code: string; currency: string }]> = [
  [/india|bengaluru|bangalore|mumbai|pune|hyderabad|delhi|gurgaon|noida|chennai/i, { code: "in", currency: "INR" }],
  [/united states|\busa?\b|new york|san francisco|seattle|austin/i, { code: "us", currency: "USD" }],
  [/united kingdom|london|\buk\b/i, { code: "gb", currency: "GBP" }],
  [/germany|berlin|munich/i, { code: "de", currency: "EUR" }],
  [/singapore/i, { code: "sg", currency: "SGD" }],
  [/canada|toronto|vancouver/i, { code: "ca", currency: "CAD" }],
  [/australia|sydney|melbourne/i, { code: "au", currency: "AUD" }],
];

function resolveCountry(location: string): { code: string; currency: string } {
  for (const [re, c] of COUNTRY) if (re.test(location)) return c;
  return { code: "us", currency: "USD" };
}

export function hasAdzunaKeys(): boolean {
  return !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
}

export async function fetchAdzunaSalary(
  archetype: RoleArchetype,
  location: string,
): Promise<AdzunaSalary | null> {
  if (!hasAdzunaKeys()) return null;
  const { code, currency } = resolveCountry(location);
  const what = ARCHETYPE_QUERY[archetype] ?? "software engineer";
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID!,
    app_key: process.env.ADZUNA_APP_KEY!,
    what,
    results_per_page: "50",
    "content-type": "application/json",
  });
  if (location && code) params.set("where", location);

  const data = await httpJson<AdzunaResp>(
    `https://api.adzuna.com/v1/api/jobs/${code}/search/1?${params}`,
  );
  if (!data) return null;

  const salaries: number[] = [];
  for (const r of data.results ?? []) {
    if (r.salary_min && r.salary_max) salaries.push((r.salary_min + r.salary_max) / 2);
    else if (r.salary_min) salaries.push(r.salary_min);
  }
  if (salaries.length >= 4) {
    salaries.sort((a, b) => a - b);
    const min = Math.round(percentile(salaries, 0.25));
    const max = Math.round(percentile(salaries, 0.75));
    return { min, max, currency, source: "adzuna", confidence: "medium", sampleCount: salaries.length };
  }
  if (data.mean && data.mean > 0) {
    return { min: Math.round(data.mean * 0.8), max: Math.round(data.mean * 1.2), currency, source: "adzuna", confidence: "medium", sampleCount: data.count };
  }
  return null;
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}
