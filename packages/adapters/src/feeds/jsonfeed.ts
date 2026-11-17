import { createHash } from "node:crypto";
import { JsonFeedMapping, type RawPosting } from "@jobflow/core";
import { htmlToText, type FetchTarget, type SourceAdapter } from "../types.js";
import { safeFetchText } from "../net.js";
import { recordFeedError, type TextFetcher } from "./rss.js";

/**
 * Generic JSON job feed (Tier 1: a public URL the USER configured — jsonfeed.org or any
 * JSON array of jobs). FetchTarget params: { url, feedKey, mapping? } where `mapping` is a
 * JSON-encoded JsonFeedMapping of dot-paths (defaults follow jsonfeed.org). Fetched only
 * through `safeFetchText` (SSRF guard + size cap). Ids are `${feedKey}:${id}` →
 * `json_feed:<feedKey>:<id>` after scopedJobId, so feeds never collide (invariant #5).
 */

const defaultFetcher: TextFetcher = (url) => safeFetchText(url, { accept: "application/feed+json, application/json;q=0.9, */*;q=0.5" });

export class JsonFeedAdapter implements SourceAdapter {
  readonly source = "json_feed" as const;
  readonly tier = "tier1" as const;

  constructor(private readonly fetchText: TextFetcher = defaultFetcher) {}

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const url = String(target.params?.url ?? "");
    if (!url) return [];
    const feedKey = String(target.params?.feedKey ?? "").trim() || createHash("sha1").update(url.toLowerCase()).digest("hex").slice(0, 12);
    let mapping: JsonFeedMapping;
    try {
      const m = target.params?.mapping;
      mapping = JsonFeedMapping.parse(typeof m === "string" && m.trim() ? JSON.parse(m) : {});
    } catch {
      recordFeedError(feedKey, "invalid field mapping");
      return [];
    }
    let data: unknown;
    try {
      data = JSON.parse(await this.fetchText(url));
    } catch (e) {
      recordFeedError(feedKey, e instanceof SyntaxError ? "not valid JSON" : (e as Error).message);
      return [];
    }
    const out = parseJsonFeed(data, mapping, { feedKey, feedUrl: url });
    return target.limit ? out.slice(0, target.limit) : out;
  }
}

/** `a.b.0.c` lookup; "" (or ".") is the value itself. */
export function getPath(obj: unknown, path: string | null | undefined): unknown {
  if (path == null) return undefined;
  const p = path.trim();
  if (!p || p === ".") return obj;
  let cur: unknown = obj;
  for (const key of p.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(str).filter((x): x is string => !!x);
    return parts.length ? parts.join("; ") : null;
  }
  if (typeof v === "object") {
    // { name: "Acme" } / { display_name: "Berlin" } — common nested shapes
    const o = v as Record<string, unknown>;
    return str(o.name ?? o.display_name ?? o.title ?? o.label ?? null);
  }
  return null;
}

/** ISO string, epoch seconds or epoch millis → ISO; anything else → null. */
function date(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string") {
    if (/^\d{9,13}$/.test(v.trim())) return date(Number(v.trim()));
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

/** Map a JSON document to raw postings via the mapping (pure; exported for fixture tests). */
export function parseJsonFeed(data: unknown, mappingInput: Partial<JsonFeedMapping> | JsonFeedMapping, ctx: { feedKey: string; feedUrl?: string }): RawPosting[] {
  const mapping = JsonFeedMapping.parse(mappingInput);
  const list = Array.isArray(data) && !mapping.itemsPath.trim() ? data : getPath(data, mapping.itemsPath);
  const items = Array.isArray(list) ? list : Array.isArray(data) ? data : [];
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, 2000)) {
    if (!item || typeof item !== "object") continue;
    const title = str(getPath(item, mapping.title));
    if (!title) continue;
    const url = str(getPath(item, mapping.url));
    const rawId = str(getPath(item, mapping.id)) ?? (url ? createHash("sha1").update(url).digest("hex") : null);
    if (!rawId) continue;
    const idPart = rawId.length > 160 ? createHash("sha1").update(rawId).digest("hex") : rawId;
    const id = `${ctx.feedKey}:${idPart}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const desc = str(getPath(item, mapping.description)) ?? "";
    out.push({
      source: "json_feed",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: id,
      companyName: (str(getPath(item, mapping.company)) ?? "Unknown").slice(0, 120),
      companySlug: null,
      title: title.slice(0, 200),
      jdText: htmlToText(desc),
      jdHtml: /<[a-z][\s\S]*>/i.test(desc) ? desc : null,
      locationRaw: mapping.location ? str(getPath(item, mapping.location)) : null,
      applyUrl: url,
      salaryRaw: mapping.salary ? str(getPath(item, mapping.salary)) : null,
      postedAt: mapping.postedAt ? date(getPath(item, mapping.postedAt)) : null,
      fetchedAt: new Date(),
      raw: { feedKey: ctx.feedKey, id: rawId, feedUrl: ctx.feedUrl ?? null },
    });
  }
  return out;
}
