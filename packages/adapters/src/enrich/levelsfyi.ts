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
