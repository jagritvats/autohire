import type { RawPosting } from "@jobflow/core";
import { httpJson, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * HN "Ask HN: Who is hiring?" harvester (Tier 1, free, no auth). Founders post
 * directly → excellent startup discovery + plain-text comp. Verified live:
 *   1. find latest whoishiring story:
 *      GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring
 *   2. pull its comments:
 *      GET https://hn.algolia.com/api/v1/items/{storyId}
 */

interface HnSearchHit {
  objectID: string;
  title: string;
  created_at: string;
}
interface HnSearchResp {
  hits: HnSearchHit[];
}
interface HnItem {
  id: number;
  text?: string;
  author?: string;
  created_at?: string;
  children?: HnItem[];
}

// "Company | Role | Location | Remote | $comp | apply-link" — first line is the lede
const COMPANY_LINE = /^([A-Z0-9][^|\n]{1,60}?)\s*[|\-–—]/;

export class HnWhoIsHiringAdapter implements SourceAdapter {
  readonly source = "hn_whoishiring" as const;
  readonly tier = "tier1" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const search = await httpJson<HnSearchResp>(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=3",
    );
    const story = (search?.hits ?? []).find((h) => /who is hiring/i.test(h.title));
    if (!story) return [];

    const item = await httpJson<HnItem>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
    const comments = (item?.children ?? []).filter((c) => c.text && !c.author?.includes("whoishiring"));

    const out: RawPosting[] = [];
    const limit = target.limit ?? 200;
    for (const c of comments) {
      if (out.length >= limit) break;
      if (!c.text) continue;
      const text = decodeHnHtml(c.text);
      // optional keyword filter (e.g. "backend", "remote", "fintech")
      if (target.query && !text.toLowerCase().includes(target.query.toLowerCase())) continue;

      const firstLine = text.split("\n")[0] ?? "";
      const company = deriveCompany(firstLine);
      if (!company) continue;

      const applyUrl = (text.match(/https?:\/\/[^\s)>\]]+/) ?? [null])[0];

      out.push({
        source: "hn_whoishiring",
        tier: "tier1",
        atsType: "unknown",
        atsJobId: String(c.id),
        companyName: company,
        companySlug: null,
        title: deriveTitle(firstLine),
        jdText: text,
        jdHtml: null,
        locationRaw: deriveLocation(firstLine),
        applyUrl,
        salaryRaw: (text.match(/\$[\d,]+k?(\s*[-–]\s*\$?[\d,]+k?)?|\d+\s*LPA/i) ?? [null])[0],
        postedAt: c.created_at ?? story.created_at,
        fetchedAt: new Date(),
        raw: { hnId: c.id, storyId: story.objectID } as Record<string, unknown>,
      });
    }
    return out;
  }
}

const ROLE_HINT = /engineer|developer|sde|swe|backend|frontend|platform|sre|staff|senior/i;

/**
 * The convention is "Company | Role | Location", but some posts lead with the role
 * ("Senior Python Engineer | Acme | Remote") — then the company is the first segment
 * that doesn't read like a role or a location.
 */
const NOT_COMPANY = /\b(remote|onsite|on[- ]site|hybrid|full[- ]time|part[- ]time|contract|visa|hiring)\b|[$€£]/i;
function deriveCompany(line: string): string {
  const lede = (line.match(COMPANY_LINE)?.[1] ?? line.slice(0, 50)).trim();
  if (!ROLE_HINT.test(lede) && !NOT_COMPANY.test(lede)) return lede;
  const parts = line.split(/[|]/).map((s) => s.trim()).filter(Boolean);
  const alt = parts.find((p) => !ROLE_HINT.test(p) && !NOT_COMPANY.test(p) && p.length <= 60);
  return alt ?? lede;
}

function deriveTitle(line: string): string {
  const parts = line.split(/[|]/).map((s) => s.trim());
  const roleHint = parts.find((p) => ROLE_HINT.test(p));
  return roleHint ?? parts[1] ?? "Engineering role";
}

function deriveLocation(line: string): string | null {
  if (/\bremote\b/i.test(line)) return `Remote ${(line.match(/remote[^|]*/i) ?? [""])[0]}`.trim();
  const parts = line.split(/[|]/).map((s) => s.trim());
  return parts.find((p) => /\b(US|USA|EU|India|Bangalore|Bengaluru|London|Berlin|SF|NYC|onsite|hybrid)\b/i.test(p)) ?? null;
}

function decodeHnHtml(html: string): string {
  return html
    .replace(/<p>/gi, "\n")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/[ \t]+/g, " ")
    .trim();
}
