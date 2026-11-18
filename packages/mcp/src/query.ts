import { formatAmount, type SearchQuery, type SourceKind } from "@jobflow/core";
import { searchCapableAdapters } from "@jobflow/adapters";
import { listPresets, makeSearchQuery } from "@jobflow/pipeline";
import { ToolError } from "./refs.js";

/**
 * Search input → SearchQuery through the SAME parser `jobflow search` uses: the free-text
 * `query` may carry CLI flag syntax (`"backend engineer" --remote --posted 7d`), and the
 * structured fields are appended as the equivalent flags, so both forms mean exactly the
 * same thing and nothing is parsed twice.
 */
export interface QueryFields {
  query?: string;
  keywords?: string[];
  titles?: string[];
  remote?: "only" | "exclude" | "any";
  locations?: string[];
  countries?: string[];
  seniority?: string[];
  minSalary?: string;
  postedWithinDays?: number;
  mustSkills?: string[];
  niceSkills?: string[];
  excludeCompanies?: string[];
  excludeKeywords?: string[];
  presets?: string[];
  sources?: string[];
}

const q = (v: string) => `"${v.replace(/["“”]/g, "").trim()}"`;

export function queryText(f: QueryFields): string {
  const parts: string[] = [];
  if (f.query?.trim()) parts.push(f.query.trim());
  for (const k of f.keywords ?? []) if (k.trim()) parts.push(q(k));
  const flag = (name: string, vals: string[] | undefined) => {
    for (const v of vals ?? []) if (v.trim()) parts.push(`--${name} ${q(v)}`);
  };
  if (f.remote === "only") parts.push("--remote");
  if (f.remote === "exclude") parts.push("--onsite");
  flag("title", f.titles);
  flag("loc", f.locations);
  flag("country", f.countries);
  flag("seniority", f.seniority);
  if (f.minSalary?.trim()) parts.push(`--min-salary ${q(f.minSalary)}`);
  if (f.postedWithinDays) parts.push(`--posted ${Math.round(f.postedWithinDays)}d`);
  flag("must", f.mustSkills);
  flag("nice", f.niceSkills);
  flag("exclude-company", f.excludeCompanies);
  flag("exclude", f.excludeKeywords);
  flag("preset", f.presets);
  flag("sources", f.sources);
  return parts.join(" ");
}

export function buildQuery(f: QueryFields): SearchQuery {
  const text = queryText(f);
  const query = makeSearchQuery(text);
  // what the parser silently drops, say out loud (an agent can't see a flag being ignored)
  const knownPresets = listPresets().map((p) => p.id);
  const badPresets = query.presets.filter((p) => !knownPresets.includes(p));
  if (badPresets.length) throw new ToolError(`unknown preset(s): ${badPresets.join(", ")}`, `Presets: ${knownPresets.join(", ")}`);
  const capable = searchCapableAdapters().map((a) => a.source as string);
  const askedSources = [...text.matchAll(/--sources?\s+(?:"([^"]*)"|(\S+))/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = askedSources.filter((s) => !query.sources.includes(s as SourceKind));
  if (unknown.length) throw new ToolError(`unknown source(s): ${unknown.join(", ")}`, `Search-capable sources: ${capable.join(", ")}`);
  if (/--(min-salary|salary)\b/.test(text) && !query.minSalary) throw new ToolError("couldn't read the minimum salary", 'Try "150000 USD", "150k USD" or "40L INR".');
  if (/--(posted|within|posted-within)\b/.test(text) && !query.postedWithinDays) throw new ToolError("couldn't read the posted-within age", "Try 7d, 2w or 1m (or postedWithinDays: 7).");
  return query;
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return !query.keywords.length && !query.titles.length && !query.mustSkills.length && !query.presets.length;
}

/** one-line description of a query ("“backend engineer” · remote · senior · ≥ 150,000 USD") */
export function describeQuery(query: SearchQuery): string {
  const parts: string[] = [];
  const bare = (k: string) => k.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "");
  if (query.keywords.length) parts.push(query.keywords.map((k) => `“${bare(k)}”`).join(" "));
  if (query.titles.length) parts.push(`title: ${query.titles.join("/")}`);
  if (query.remote === "only") parts.push("remote");
  if (query.remote === "exclude") parts.push("on-site");
  if (query.locations.length) parts.push(query.locations.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join(" | "));
  if (query.seniority.length) parts.push(query.seniority.join("/"));
  if (query.minSalary) parts.push(`≥ ${formatAmount(query.minSalary.amount, query.minSalary.currency, query.minSalary.period)}`);
  if (query.postedWithinDays) parts.push(`≤ ${query.postedWithinDays}d old`);
  if (query.mustSkills.length) parts.push(`must: ${query.mustSkills.join(", ")}`);
  if (query.excludeCompanies.length) parts.push(`not: ${query.excludeCompanies.join(", ")}`);
  if (query.sources.length) parts.push(`sources: ${query.sources.join(", ")}`);
  if (query.presets.length) parts.push(query.presets.map((p) => `#${p}`).join(" "));
  return parts.join(" · ") || "(everything)";
}
