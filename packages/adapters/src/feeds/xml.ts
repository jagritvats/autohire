/**
 * Dependency-free RSS 2.0 / Atom 1.0 item parsing for user-configured job feeds. Not a
 * general XML parser: it reads the handful of item fields a job feed carries, handling
 * CDATA, XML/HTML entities and namespaced tags (dc:creator, content:encoded). Same
 * regex-over-markup approach as the Reddit Atom reader (india/reddit.ts), lifted here
 * so every feed shares it.
 */

export interface FeedItem {
  title: string;
  link: string | null;
  /** RSS <guid> / Atom <id> */
  guid: string | null;
  /** HTML or text body (content:encoded > description, Atom content > summary) */
  description: string;
  /** ISO date when parseable */
  published: string | null;
  /** dc:creator / author name */
  author: string | null;
  categories: string[];
  /** job-feed extensions some boards add (<location>, <job:location>, <company>) */
  location: string | null;
  company: string | null;
}

export interface ParsedFeed {
  kind: "rss" | "atom" | "unknown";
  title: string | null;
  items: FeedItem[];
}

const NAMED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** decode XML/HTML entities in one pass (so "&amp;lt;" → "&lt;", never "<"). */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/**
 * Text of an element's content: CDATA sections are literal (no entity decoding inside);
 * everything outside them is entity-decoded.
 */
export function xmlText(inner: string): string {
  let out = "";
  let rest = inner;
  for (;;) {
    const start = rest.indexOf("<![CDATA[");
    if (start < 0) {
      out += decodeXmlEntities(rest);
      break;
    }
    out += decodeXmlEntities(rest.slice(0, start));
    const end = rest.indexOf("]]>", start + 9);
    if (end < 0) {
      out += rest.slice(start + 9);
      break;
    }
    out += rest.slice(start + 9, end);
    rest = rest.slice(end + 3);
  }
  return out.trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** inner markup of the first <name …>…</name> in a block (exact, possibly prefixed name). */
function inner(block: string, name: string): string | null {
  const n = escapeRe(name);
  const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}\\s*>`, "i"));
  return m ? m[1]! : null;
}

function allInner(block: string, name: string): string[] {
  const n = escapeRe(name);
  return [...block.matchAll(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}\\s*>`, "gi"))].map((m) => m[1]!);
}

function text(block: string, ...names: string[]): string | null {
  for (const name of names) {
    const v = inner(block, name);
    if (v != null) {
      const t = xmlText(v);
      if (t) return t;
    }
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeXmlEntities(m[2] ?? m[3] ?? "") : null;
}

/** split into item/entry blocks; CDATA can't contain a literal "</item>" in valid feeds. */
function blocks(xml: string, tag: string): string[] {
  const t = escapeRe(tag);
  return [...xml.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}\\s*>`, "gi"))].map((m) => m[1]!);
}

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Atom <link>: rel="alternate" (or no rel) wins; RSS <link>text</link> handled separately. */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[0]);
  const alt = links.find((l) => {
    const rel = attr(l, "rel");
    return !rel || rel === "alternate";
  });
  return (alt && attr(alt, "href")) || (links[0] && attr(links[0], "href")) || null;
}

/** Parse an RSS 2.0 or Atom feed into items (best effort; never throws). */
export function parseFeed(xml: string): ParsedFeed {
  const src = (xml ?? "").replace(/^﻿/, "");
  const isAtom = /<feed\b[^>]*>/i.test(src) && !/<rss\b/i.test(src);
  if (isAtom) {
    const head = src.split(/<entry\b/i)[0] ?? "";
    const items = blocks(src, "entry").map((b): FeedItem => {
      const authorBlock = inner(b, "author");
      return {
        title: text(b, "title") ?? "",
        link: atomLink(b),
        guid: text(b, "id"),
        description: text(b, "content", "summary") ?? "",
        published: isoDate(text(b, "published", "updated")),
        author: (authorBlock ? text(authorBlock, "name") : null) ?? text(b, "dc:creator"),
        categories: [...b.matchAll(/<category\b([^>]*?)\/?>/gi)].map((m) => attr(m[0], "term") ?? attr(m[0], "label") ?? "").filter(Boolean),
        location: text(b, "location", "job:location"),
        company: text(b, "company", "job:company"),
      };
    });
    return { kind: "atom", title: text(head, "title"), items };
  }
  if (/<rss\b|<rdf:RDF\b|<channel\b/i.test(src)) {
    const head = src.split(/<item\b/i)[0] ?? "";
    const items = blocks(src, "item").map((b): FeedItem => {
      const rawLink = text(b, "link");
      return {
        title: text(b, "title") ?? "",
        link: rawLink || atomLink(b),
        guid: text(b, "guid"),
        description: text(b, "content:encoded", "description") ?? "",
        published: isoDate(text(b, "pubDate", "dc:date", "published", "updated")),
        author: text(b, "dc:creator", "author"),
        categories: allInner(b, "category").map(xmlText).filter(Boolean),
        location: text(b, "location", "job:location", "region"),
        company: text(b, "company", "job:company"),
      };
    });
    return { kind: "rss", title: text(head, "title"), items };
  }
  return { kind: "unknown", title: null, items: [] };
}
