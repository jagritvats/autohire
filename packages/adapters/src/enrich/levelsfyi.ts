import type { RoleArchetype } from "@jobflow/core";
import { normCompany, slugify } from "@jobflow/core";

/** Company name → levels.fyi url slug (lowercase, hyphenated, suffixes stripped). */
export function slugFromName(name: string): string {
  return slugify(normCompany(name));
}

/**
 * levels.fyi enrichment (Tier 1, free, attribution required §11.4). The site exposes
 * agent-friendly markdown at:
 *   GET https://www.levels.fyi/companies/{slug}/salaries.md   (verified live, text/markdown)
 * It returns an all-roles median + a per-job-family median table (USD, US scope).
 *
 * Attribution: any derived display must credit "Data source: Levels.fyi
 * (https://www.levels.fyi)" — surfaced on the company view + card comp source.
 */

export interface LevelsComp {
  slug: string;
  currency: string;
  scopeLocation: string;
  medianAll: number | null;
  families: Array<{ family: string; median: number }>;
  source: "levelsfyi";
  attribution: string;
}

const UA = "JobFlow/0.1 (personal job-search; +levels.fyi attribution)";
export const LEVELS_ATTRIBUTION = "Data source: Levels.fyi (https://www.levels.fyi)";

export async function fetchLevelsComp(companySlug: string): Promise<LevelsComp | null> {
  const slug = companySlug.toLowerCase().replace(/\s+/g, "-");
  const url = `https://www.levels.fyi/companies/${encodeURIComponent(slug)}/salaries.md`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let md = "";
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "text/markdown" } });
    if (!res.ok) return null;
    md = await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  // a real company page contains the comp table; a miss returns a near-empty/landing md
  if (!/Median Total Compensation/i.test(md)) return null;
  return parseLevelsMarkdown(slug, md);
}

export function parseLevelsMarkdown(slug: string, md: string): LevelsComp {
  const currency = (md.match(/\*\*Currency:\*\*\s*([A-Z]{3})/) ?? [])[1] ?? "USD";
  const scopeLocation = (md.match(/\*\*Location:\*\*\s*([^\n]+)/) ?? [])[1]?.trim() ?? "United States";
  const medianAll = parseMoney((md.match(/Median Total Compensation \(All Roles\):\s*([^\n]+)/i) ?? [])[1]);

  const families: Array<{ family: string; median: number }> = [];
  // table rows: | 1 | Software Engineer | $454,854 |
  const rowRe = /\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([₹$€£][\d,]+)\s*\|/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(md))) {
    const median = parseMoney(m[2]);
    if (m[1] && median != null) families.push({ family: m[1].trim(), median });
  }

  return { slug, currency, scopeLocation, medianAll, families, source: "levelsfyi", attribution: LEVELS_ATTRIBUTION };
}

// ── market benchmarks: software-engineer pay per market × level ──────────────────

/**
 * levels.fyi's per-market software-engineer summaries (Tier 1, free, attributed §11.4):
 *   GET https://www.levels.fyi/t/software-engineer/locations/{country}.md
 *   GET https://www.levels.fyi/t/software-engineer/levels/{entry-level|senior}/locations/{country}.md
 * Each carries median + p25/p75 total comp and the submission count (verified live
 * 2026-09: India entry ₹13.6L / all ₹30.3L / senior ₹49.8L). Only those two level pages
 * exist — "junior"/"staff"/"mid-level" 404 — so other levels are priced off these along
 * the market's ladder in core.
 */
export type LevelsMarketLevel = "all" | "entry-level" | "senior";

/** SalaryMarket → levels.fyi location slug. Germany stands in for the EU market. */
export const LEVELS_MARKET_SLUG: Readonly<Record<string, string>> = {
  IN: "india",
  US: "united-states",
  CA: "canada",
  GB: "united-kingdom",
  EU: "germany",
  SG: "singapore",
  AU: "australia",
};

export interface LevelsMarketComp {
  market: string;
  level: LevelsMarketLevel;
  currency: string;
  median: number;
  p25: number | null;
  p75: number | null;
  sampleCount: number | null;
  source: "levelsfyi";
  attribution: string;
}

export async function fetchLevelsMarket(market: string, level: LevelsMarketLevel): Promise<LevelsMarketComp | null> {
  const loc = LEVELS_MARKET_SLUG[market];
  if (!loc) return null;
  const path = level === "all" ? `locations/${loc}` : `levels/${level}/locations/${loc}`;
  const md = await fetchMarkdown(`https://www.levels.fyi/t/software-engineer/${path}.md`);
  return md ? parseLevelsMarketMarkdown(market, level, md) : null;
}

/** Currency prefixes the market pages use ("₹3,028,181", "CA$139,191", "SGD 115,712"). */
const MONEY_PREFIX: Array<[RegExp, string]> = [
  [/^CA\$/, "CAD"], [/^A\$/, "AUD"], [/^SGD\s?/, "SGD"], [/^S\$/, "SGD"], [/^₹/, "INR"],
  [/^£/, "GBP"], [/^€/, "EUR"], [/^\$/, "USD"],
];

export function parseLevelsMarketMarkdown(market: string, level: LevelsMarketLevel, md: string): LevelsMarketComp | null {
  const medRaw = (md.match(/Median Total Compensation:\s*([^\n|]+)/i) ?? [])[1]?.trim();
  if (!medRaw) return null; // a 404 page / redesign — never guess
  const currency = MONEY_PREFIX.find(([re]) => re.test(medRaw))?.[1];
  const median = parseMoney(medRaw);
  if (!currency || median == null) return null;
  const pct = md.match(/25th \/ 75th Percentile:\s*([^/\n]+)\/\s*([^\n|]+)/i);
  const n = md.match(/based on ([\d,]+) salary submissions/i);
  return {
    market,
    level,
    currency,
    median,
    p25: parseMoney(pct?.[1]),
    p75: parseMoney(pct?.[2]),
    sampleCount: n?.[1] ? Number(n[1].replace(/,/g, "")) : null,
    source: "levelsfyi",
    attribution: LEVELS_ATTRIBUTION,
  };
}

async function fetchMarkdown(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: "text/markdown" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── company × market: an employer's own level ladder, per country ─────────────────────

/**
 * levels.fyi's per-company, per-country software-engineer summary (Tier 1, attributed):
 *   GET https://www.levels.fyi/companies/{slug}/salaries/software-engineer/locations/{country}.md
 * Verified live 2026-09 (Amazon India: L4 ₹27.9L · L5 ₹66.4L · L6 ₹1.32Cr · L7 ₹2.36Cr). Beyond
 * the level medians it states the typical years per level, which level "Senior" is, and the
 * base/stock/bonus mix — enough to place the employer's ladder on ours and to convert its
 * total comp into what a posting would state. Smaller employers 404 → null.
 */
export interface LevelsCompanyMarket {
  slug: string;
  market: string;
  currency: string;
  medianAll: number | null;
  levels: Array<{
    /** the employer's own level name: "L5", "C11", "VP" */
    name: string;
    median: number;
    /** typical years of experience at this level, when stated */
    yoe: number | null;
    /** our ladder index (intern 0 … director 6), from yoe + the "Senior is Lx" anchor */
    index: number;
  }>;
  /**
   * share of total comp a posting would state: base (+ bonus in India, where CTC folds in
   * variable pay) ÷ total. Null when the page gives no pay mix.
   */
  postedShare: number | null;
  attribution: string;
}

export async function fetchLevelsCompanyMarket(companySlug: string, market: string): Promise<LevelsCompanyMarket | null> {
  const loc = LEVELS_MARKET_SLUG[market];
  if (!loc) return null;
  const slug = companySlug.toLowerCase().replace(/\s+/g, "-");
  const md = await fetchMarkdown(
    `https://www.levels.fyi/companies/${encodeURIComponent(slug)}/salaries/software-engineer/locations/${loc}.md`,
  );
  return md ? parseLevelsCompanyMarketMarkdown(slug, market, md) : null;
}

export function parseLevelsCompanyMarketMarkdown(slug: string, market: string, md: string): LevelsCompanyMarket | null {
  if (!/Levels Breakdown/i.test(md)) return null; // a 404 page, or a company with no level data
  const currency = (md.match(/\*\*Currency:\*\*\s*([A-Z]{3})/) ?? [])[1];
  if (!currency) return null;

  // | L5 | ₹6,640,622 |  — only rows inside the Levels Breakdown table
  const table = md.slice(md.search(/Levels Breakdown/i)).split(/\n---|\n## /)[0] ?? "";
  const rows: Array<{ name: string; median: number }> = [];
  for (const m of table.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]*\d[^|]*)\|\s*$/gm)) {
    const median = parseMoney(m[2]);
    if (m[1] && median != null && !/^level$/i.test(m[1])) rows.push({ name: m[1].trim(), median });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.median - b.median); // a ladder climbs in pay

  const yoeOf = (name: string): number | null => {
    const re = new RegExp(`at ${escapeRe(slugTitle(md))}\\s+${escapeRe(name)} in [^\\n]*?typically have (?:around )?(\\d+)(?:[–-](\\d+))? years`, "i");
    const m = md.match(re) ?? md.match(new RegExp(`\\s${escapeRe(name)} in [^\\n]*?typically have (?:around )?(\\d+)(?:[–-](\\d+))? years`, "i"));
    if (!m?.[1]) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    return (lo + hi) / 2;
  };
  const seniorName = (md.match(/A Senior Software Engineer at .+? is level ([^,.\n]+)/i) ?? [])[1]?.trim() ?? null;

  // index by years (same thresholds as a posting's asked years), then pin "Senior" and keep
  // the ladder strictly climbing around it
  let prev = -1;
  const idx = rows.map((r) => {
    const y = yoeOf(r.name);
    const i = y == null ? prev + 1 : y < 2 ? 1 : y < 5 ? 2 : y < 8 ? 3 : y < 12 ? 4 : 5;
    prev = Math.max(i, prev + 1);
    return prev;
  });
  const a = seniorName ? rows.findIndex((r) => r.name.toLowerCase() === seniorName.toLowerCase()) : -1;
  if (a >= 0) {
    idx[a] = 3;
    for (let i = a - 1; i >= 0; i--) idx[i] = Math.min(idx[i]!, idx[i + 1]! - 1);
    for (let i = a + 1; i < idx.length; i++) idx[i] = Math.max(idx[i]!, idx[i - 1]! + 1);
  }

  // "The median pay mix … is ₹5,386,286 base salary, ₹897,714 in stock per year, and ₹298,079 bonus"
  const mix = md.match(/median pay mix[^\n]*?([₹$€£][\d,]+|[A-Z]{2,3}\$?\s?[\d,]+) base salary(?:, ([^\n]*?) in stock per year)?(?:,? and ([^\n]*?) bonus)?/i);
  const base = parseMoney(mix?.[1]);
  const stock = parseMoney(mix?.[2]) ?? 0;
  const bonus = parseMoney(mix?.[3]) ?? 0;
  const postedShare =
    base != null && base > 0 ? round2((base + (market === "IN" ? bonus : 0)) / (base + stock + bonus)) : null;

  return {
    slug,
    market,
    currency,
    medianAll: parseMoney((md.match(/Median Total Compensation:\s*([^\n|]+)/i) ?? [])[1]),
    levels: rows.map((r, i) => ({ name: r.name, median: r.median, yoe: yoeOf(r.name), index: Math.max(0, Math.min(6, idx[i]!)) })),
    postedShare,
    attribution: LEVELS_ATTRIBUTION,
  };
}

/** "# Levels.fyi – Amazon Software Engineer Salaries in India" → "Amazon" */
function slugTitle(md: string): string {
  return (md.match(/^# Levels\.fyi – (.+?) Software Engineer Salaries/m) ?? [])[1] ?? "";
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Pick the family median most relevant to a role archetype (§11.4). */
const ARCHETYPE_TO_FAMILY: Record<RoleArchetype, string[]> = {
  backend: ["Software Engineer"],
  platform: ["Software Engineer"],
  infra_devops: ["Software Engineer"],
  sre: ["Software Engineer"],
  fullstack: ["Software Engineer"],
  frontend: ["Software Engineer"],
  mobile: ["Software Engineer"],
  data_ml: ["Data Scientist", "Software Engineer"],
  data_analytics: ["Data Analyst", "Data Scientist"],
  other: ["Software Engineer"],
};

export function familyMedianFor(comp: LevelsComp, archetype: RoleArchetype): number | null {
  for (const want of ARCHETYPE_TO_FAMILY[archetype] ?? ["Software Engineer"]) {
    const hit = comp.families.find((f) => f.family.toLowerCase() === want.toLowerCase());
    if (hit) return hit.median;
  }
  return comp.medianAll;
}

function parseMoney(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
