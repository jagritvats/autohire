import { createHash } from "node:crypto";
import { classifyLink, type RawPosting } from "@jobflow/core";
import { htmlToText, type FetchTarget, type SourceAdapter } from "../types.js";
import { safeFetchText } from "../net.js";
import { parseFeed, type FeedItem } from "./xml.js";

/**
 * Generic RSS 2.0 / Atom job feed (Tier 1: a public feed URL the USER configured).
 * FetchTarget params: { url, feedKey, company? }. The URL is user-supplied, so it is only
 * ever fetched through `safeFetchText` (SSRF guard + size cap). Ids are
 * `${feedKey}:${guid || sha1(link)}`, which `scopedJobId` turns into
 * `rss:<feedKey>:<guid>` — two feeds carrying the same guid can't collide (invariant #5).
 * Trust is a neutral 0.45 and dates are treated as re-stamped (core SOURCE_TRUST /
 * REDATED_SOURCES): an item date is when the FEED published it.
 */

export type TextFetcher = (url: string) => Promise<string>;

/** last fetch/parse error per feedKey — the pipeline records it on the discovery source. */
const feedErrors = new Map<string, string>();

/** read (and clear) the last error a feed adapter hit for this feedKey. */
export function takeFeedError(feedKey: string): string | null {
  const e = feedErrors.get(feedKey) ?? null;
  feedErrors.delete(feedKey);
  return e;
}
export function recordFeedError(feedKey: string, message: string): void {
  feedErrors.set(feedKey, message.slice(0, 300));
}

const defaultFetcher: TextFetcher = (url) =>
  safeFetchText(url, { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" });

export class RssFeedAdapter implements SourceAdapter {
  readonly source = "rss" as const;
  readonly tier = "tier1" as const;

  /** `fetchText` is injectable for tests; production always goes through safeFetchText. */
  constructor(private readonly fetchText: TextFetcher = defaultFetcher) {}

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const url = String(target.params?.url ?? "");
    const feedKey = String(target.params?.feedKey ?? "").trim() || feedKeyFor(url);
    if (!url) return [];
    let xml: string;
    try {
      xml = await this.fetchText(url);
    } catch (e) {
      recordFeedError(feedKey, (e as Error).message);
      return [];
    }
    const feed = parseFeed(xml);
    if (feed.kind === "unknown") {
      recordFeedError(feedKey, "not an RSS or Atom feed");
      return [];
    }
    const company = typeof target.params?.company === "string" && target.params.company.trim() ? target.params.company.trim() : null;
    const out = parseRssItems(feed.items, { feedKey, company, feedUrl: url });
    return target.limit ? out.slice(0, target.limit) : out;
  }
}

/** a stable short key for a feed URL (when the caller gave none). */
export function feedKeyFor(url: string): string {
  return sha1(url.trim().toLowerCase()).slice(0, 12);
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Map parsed feed items to raw postings (pure; exported for fixture tests). */
export function parseRssItems(
  items: FeedItem[],
  ctx: { feedKey: string; company?: string | null; feedUrl?: string },
): RawPosting[] {
  const out: RawPosting[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const rawTitle = item.title.trim();
    if (!rawTitle) continue;
    const guidSrc = item.guid?.trim() || (item.link ? sha1(item.link.trim()) : sha1(`${rawTitle}|${item.published ?? ""}`));
    // very long guids (full URLs with tracking) are hashed so the id stays a sane key
    const guid = guidSrc.length > 160 ? sha1(guidSrc) : guidSrc;
    const id = `${ctx.feedKey}:${guid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const split = splitTitleCompany(rawTitle);
    // configured > the feed's own company field > "… at Company" in the title > dc:creator
    // (a title pattern names the employer; a creator is often a person)
    const company = ctx.company?.trim() || item.company?.trim() || split.company || authorAsCompany(item.author) || "Unknown";
    const title = split.company && (!ctx.company || sameName(split.company, company)) ? split.title : rawTitle;
    out.push({
      source: "rss",
      tier: "tier1",
      atsType: "unknown",
      atsJobId: id,
      companyName: company.slice(0, 120),
      companySlug: null,
      title: title.slice(0, 200),
      jdText: htmlToText(item.description),
      jdHtml: /<[a-z][\s\S]*>/i.test(item.description) ? item.description : null,
      locationRaw: item.location ?? split.location ?? null,
      applyUrl: item.link,
      salaryRaw: null,
      postedAt: item.published,
      fetchedAt: new Date(),
      raw: { feedKey: ctx.feedKey, guid, feedUrl: ctx.feedUrl ?? null, categories: item.categories },
    });
  }
  return out;
}

/**
 * Item links that point at an employer's own ATS (Greenhouse/Lever/Workday…). The item is
 * kept as a posting, and the link ALSO feeds board discovery (pipeline harvest), so the
 * employer's board gets polled at the source.
 */
export function atsLinksFromRaws(raws: RawPosting[]): string[] {
  const out = new Set<string>();
  for (const r of raws) if (r.applyUrl && classifyLink(r.applyUrl).kind === "ats") out.add(r.applyUrl);
  return [...out];
}

/** "Senior Engineer at Acme" / "Acme is hiring a Backend Engineer" / "Acme: Backend Engineer". */
export function splitTitleCompany(t: string): { title: string; company: string | null; location?: string } {
  const s = t.trim();
  // "Senior Engineer at Acme (Remote, EU)" — a trailing parenthetical is the place
  let m = s.match(/^(.{2,120}?)\s+(?:at|@)\s+([^|()–—-][^|()]{0,80}?)\s*(?:\(([^)]*)\))?$/i);
  if (m) return { title: m[1]!.trim(), company: m[2]!.trim(), ...(m[3]?.trim() ? { location: m[3].trim() } : {}) };
  m = s.match(/^([^:|]{2,80}?)\s+is hiring\b[:\s-]*(?:an?\s+)?(.*)$/i);
  if (m) return { title: m[2]!.trim() || s, company: m[1]!.trim() };
  m = s.match(/^([^:]{2,60}):\s+(.{3,})$/);
  if (m && !/\b(engineer|developer|manager|remote|senior|junior|lead)\b/i.test(m[1]!)) return { title: m[2]!.trim(), company: m[1]!.trim() };
  return { title: s, company: null };
}

/** dc:creator is often a person or a mailbox, not the employer — only a plausible name passes. */
function authorAsCompany(author: string | null): string | null {
  const a = author?.trim();
  if (!a || a.length > 80 || /@|noreply|no-reply|admin|editor|webmaster/i.test(a)) return null;
  return a;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
