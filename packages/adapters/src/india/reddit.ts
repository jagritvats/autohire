import type { RawPosting } from "@jobflow/core";
import { decodeEntities, htmlToText, httpText, type FetchTarget, type SourceAdapter } from "../types.js";

/**
 * r/developersIndia "Who's hiring? – Monthly Megathread" (Tier 2: public RSS; the JSON
 * API answers 403). First-party posts from Indian teams, moderated into a template
 * (Company Name / Location / Role/Position / Experience Required / Pay Range / …).
 * Verified live 2026-09:
 *   GET https://www.reddit.com/r/{sub}/search.rss?q=title:"Who's hiring"&restrict_sr=1&sort=new
 *   GET {thread permalink}.rss?limit=100
 * Reddit allows ~1 RSS request/minute (a second call 2 s later got 429), so requests
 * are spaced ≥61 s and the month's thread link is cached per process. One comment can
 * hold several postings — split on "Company Name:". Low volume (~15–20/month), high
 * signal: pay ranges and direct application links.
 */

const FIELDS = [
  "Company Name",
  "Link",
  "Location",
  "Role/Position",
  "Type",
  "Experience Required",
  "Pay Range",
  "Tech Stack / Skills Required",
  "Job Description & Responsibilities",
  "Application Link / Contact Email",
] as const;
type Field = (typeof FIELDS)[number];

const MIN_GAP_MS = 61_000;
let lastRequestAt = 0;
const threadByMonth = new Map<string, string>();

async function politeGet(url: string): Promise<string | null> {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return httpText(url, { timeoutMs: 30_000, headers: { Accept: "application/atom+xml" } });
}

export class RedditHiringAdapter implements SourceAdapter {
  readonly source = "reddit" as const;
  readonly tier = "tier2" as const;

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    const sub = String(target.params?.subreddit ?? "developersIndia").replace(/[^a-z0-9_]/gi, "");
    const month = new Date().toISOString().slice(0, 7);
    let thread = threadByMonth.get(`${sub}:${month}`);
    if (!thread) {
      const q = encodeURIComponent(`title:"Who's hiring"`);
      const search = await politeGet(`https://www.reddit.com/r/${sub}/search.rss?q=${q}&restrict_sr=1&sort=new`);
      thread = search ? findMegathread(search) ?? undefined : undefined;
      if (!thread) return [];
      threadByMonth.set(`${sub}:${month}`, thread);
    }
    const feed = await politeGet(`${thread.replace(/\/$/, "")}/.rss?limit=100`);
    return feed ? parseHiringThread(feed).slice(0, target.limit ?? 100) : [];
  }
}

/** First search entry titled "… Monthly Megathread" → its permalink. */
export function findMegathread(atom: string): string | null {
  for (const entry of atom.split("<entry>").slice(1)) {
    const title = decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const link = entry.match(/<link href="([^"]+)"/)?.[1];
    if (link && /monthly megathread/i.test(title)) return link;
  }
  return null;
}

/** Comments feed → one RawPosting per "Company Name:" block. */
export function parseHiringThread(atom: string): RawPosting[] {
  const out: RawPosting[] = [];
  for (const entry of atom.split("<entry>").slice(1)) {
    const html = decodeEntities(entry.match(/<content type="html">([\s\S]*?)<\/content>/)?.[1] ?? "");
    const text = htmlToText(html);
    if (!/company name\s*:/i.test(text)) continue;
    const commentId = entry.match(/<id>([^<]+)<\/id>/)?.[1] ?? "";
    const updated = entry.match(/<(?:published|updated)>([^<]+)<\/(?:published|updated)>/)?.[1] ?? null;
    const blocks = text.split(/(?=company name\s*:)/i).filter((b) => /company name\s*:/i.test(b));
    blocks.forEach((block, idx) => {
      const f = parseTemplate(block);
      const company = f["Company Name"]?.trim();
      const role = f["Role/Position"]?.trim();
      if (!company || !role) return;
      const apply = firstUrl(f["Application Link / Contact Email"]) ?? firstUrl(f.Link);
      out.push({
        source: "reddit",
        tier: "tier2",
        atsType: "unknown",
        atsJobId: `${commentId}#${idx}`,
        companyName: company.slice(0, 80),
        companySlug: null,
        title: role.slice(0, 140),
        jdText: block.trim(),
        jdHtml: null,
        locationRaw: f.Location?.trim() || null,
        applyUrl: apply,
        salaryRaw: f["Pay Range"]?.trim() || null,
        postedAt: updated,
        fetchedAt: new Date(),
        raw: { commentId } as Record<string, unknown>,
      });
    });
  }
  return out;
}

const LABEL_RE = new RegExp(`(${FIELDS.map((f) => f.replace(/[/&]/g, (c) => `\\${c}`)).join("|")})\\s*:`, "gi");

function parseTemplate(block: string): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const hits = [...block.matchAll(LABEL_RE)];
  hits.forEach((m, i) => {
    const label = FIELDS.find((f) => f.toLowerCase() === m[1]!.toLowerCase());
    if (!label || out[label]) return;
    const start = (m.index ?? 0) + m[0].length;
    const end = hits[i + 1]?.index ?? block.length;
    out[label] = block.slice(start, end).trim();
  });
  return out;
}

function firstUrl(s: string | undefined): string | null {
  return s?.match(/https?:\/\/[^\s)>\]]+/)?.[0] ?? null;
}
