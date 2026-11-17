import { z } from "zod";
import { LevelBand, RemoteGeo, SourceKind } from "./enums.js";

const uuid = z.string().uuid();
const ts = z.union([z.string().datetime({ offset: true }), z.date()]);

/**
 * A job search the user asked for. Two roles (§ searches):
 *  - as a SOURCE query — mapped onto search-capable adapters (`toTargets`), results ingested;
 *  - as a feed VIEW — the user's explicit filter over their ranked feed. A view hides only on
 *    confidently-known values, never changes a score, and always reports what it hid
 *    (invariant #4: ranking stays soft; a view is the user's choice, made visible).
 */
export const SearchQuery = z.object({
  /** free-text keywords (any of). */
  keywords: z.array(z.string()).default([]),
  /** target titles, e.g. "backend engineer". */
  titles: z.array(z.string()).default([]),
  mustSkills: z.array(z.string()).default([]),
  /** only ever boosts "search relevance"; never hides. */
  niceSkills: z.array(z.string()).default([]),
  locations: z
    .array(
      z.object({
        city: z.string().nullable().default(null),
        /** ISO-3166 alpha-2 */
        country: z.string().nullable().default(null),
      }),
    )
    .default([]),
  remote: z.enum(["any", "only", "exclude"]).default("any"),
  remoteGeo: z.array(RemoteGeo).default([]),
  seniority: z.array(LevelBand).default([]),
  minSalary: z.object({ amount: z.number(), currency: z.string() }).nullable().default(null),
  postedWithinDays: z.number().int().positive().nullable().default(null),
  /** [] = every enabled, search-capable source. */
  sources: z.array(SourceKind).default([]),
  excludeCompanies: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  /**
   * discovery-preset TAGS (`india`, `us`, …): only postings from those presets' companies or
   * feeds. A tag filter, like the others — never a rescoring. For a live search it also
   * picks the presets' sources when `sources` is empty.
   */
  presets: z.array(z.string()).default([]),
});
export type SearchQuery = z.infer<typeof SearchQuery>;
export type SearchQueryInput = z.input<typeof SearchQuery>;

export const SavedSearch = z.object({
  id: uuid,
  tenantId: uuid,
  name: z.string().min(1).max(80),
  query: SearchQuery,
  /** push the query into search-capable sources on the cadence. */
  asSource: z.boolean().default(true),
  /** offer it as a feed view. */
  asView: z.boolean().default(true),
  cadence: z.enum(["daily", "weekly", "manual"]).default("daily"),
  enabled: z.boolean().default(true),
  lastRunAt: ts.nullable().default(null),
  lastResult: z.record(z.unknown()).nullable().default(null),
  createdAt: ts,
});
export type SavedSearch = z.infer<typeof SavedSearch>;

/** why a view hid a match — every hidden card is counted under exactly one reason. */
export const ViewHiddenReason = z.enum([
  "preset",
  "location",
  "remote",
  "seniority",
  "salary",
  "age",
  "company",
  "keyword",
  "skill",
]);
export type ViewHiddenReason = z.infer<typeof ViewHiddenReason>;

// ── configurable discovery (in addition to the built-in preset) ──

export const DiscoverySourceKind = z.enum(["rss", "json_feed", "telegram", "hn_thread", "company_list"]);
export type DiscoverySourceKind = z.infer<typeof DiscoverySourceKind>;

/** dot-paths into a JSON feed; defaults follow jsonfeed.org. */
export const JsonFeedMapping = z.object({
  itemsPath: z.string().default("items"),
  id: z.string().default("id"),
  title: z.string().default("title"),
  company: z.string().default("company"),
  url: z.string().default("url"),
  location: z.string().nullable().default(null),
  description: z.string().nullable().default("content_html"),
  postedAt: z.string().nullable().default("date_published"),
  salary: z.string().nullable().default(null),
});
export type JsonFeedMapping = z.infer<typeof JsonFeedMapping>;

export const DiscoverySourceConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rss"), url: z.string().url(), company: z.string().nullable().default(null) }),
  z.object({ kind: z.literal("json_feed"), url: z.string().url(), mapping: JsonFeedMapping.default({}) }),
  z.object({ kind: z.literal("telegram"), channel: z.string().regex(/^[A-Za-z0-9_]{3,64}$/) }),
  z.object({ kind: z.literal("hn_thread"), storyId: z.string().regex(/^\d+$/).nullable().default(null) }),
  /** a named list of companies (names or careers URLs) resolved by the ATS detector. */
  z.object({
    kind: z.literal("company_list"),
    companies: z.array(z.object({ name: z.string(), careersUrl: z.string().nullable().default(null) })).max(500),
  }),
]);
export type DiscoverySourceConfig = z.infer<typeof DiscoverySourceConfig>;

export const DiscoverySource = z.object({
  id: uuid,
  tenantId: uuid,
  label: z.string().max(120),
  config: DiscoverySourceConfig,
  /** sha1 of the normalized config — dedupes identical sources across tenants in the cron. */
  configKey: z.string(),
  enabled: z.boolean().default(true),
  lastRunAt: ts.nullable().default(null),
  lastStatus: z.enum(["ok", "empty", "error"]).nullable().default(null),
  lastCount: z.number().int().nullable().default(null),
  lastError: z.string().nullable().default(null),
  createdAt: ts,
});
export type DiscoverySource = z.infer<typeof DiscoverySource>;

/** stable JSON (sorted keys) of a discovery config — input to `configKey`. */
export function canonicalConfigJson(c: DiscoverySourceConfig): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : typeof v === "string"
          ? v.trim()
          : v;
  return JSON.stringify(sort(c));
}
