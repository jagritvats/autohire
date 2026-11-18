/**
 * Source text → readable text: JD HTML to plain text, a title's entities decoded. The
 * adapters run this at ingest; the re-normalize pass (`renormalizePosting`, pipeline) runs it
 * over STORED rows, so a JD saved before the cleanup existed reads the same as a fresh one
 * without waiting for its board's next poll (§11.3).
 */

/**
 * Strip HTML to readable text for JD parsing (ATS JDs come as HTML). Greenhouse sends its
 * content entity-ESCAPED ("&lt;p&gt;…"), so escaped markup is unescaped before the tags are
 * stripped; numeric entities ("C&#43;&#43;", "3&#43; years", "&#xa0;") are decoded too —
 * left in, they hid C++ and "3+ years" from the parsers and showed as junk on the Job page
 * (2026-11 feed review: 1,781 Greenhouse and 1,997 Workday JDs in one corpus).
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const src = /&lt;\/?[a-z][a-z0-9]*[\s&]|&lt;\/?[a-z][a-z0-9]*&gt;/i.test(html) ? decodeBasicEntities(html) : html;
  return decodeAllEntities(
    src
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** markup or entities in a stored JD: HTML tags (raw or escaped) or an entity reference */
const MARKUP_RE = /<\/?(?:p|div|span|br|li|ul|ol|h[1-6]|strong|b|em|i|a|table|tr|td|section|style|script)\b[^>]*>|&lt;\/?[a-z][a-z0-9]*(?:[\s&]|&gt;)|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]{1,7});/i;

/**
 * A stored JD as the adapters would store it today: run through `htmlToText` when it still
 * carries markup or entities, else returned as is — plain text is never re-flowed, so the
 * pass is idempotent (cleaned text has no tags or entities left to find).
 */
export function cleanStoredJd(text: string): string {
  return text && MARKUP_RE.test(text) ? htmlToText(text) : text;
}

/**
 * A job title as a person reads it: entities decoded ("Partnerships &amp; Growth"), tags
 * dropped, whitespace collapsed, and a repeated comma segment kept once (Amazon joins
 * team names into the title: "SDE, Middle Mile, Middle Mile, Relay Yard Automation").
 */
export function cleanTitle(raw: string | null | undefined): string {
  const t = decodeAllEntities(decodeBasicEntities(raw ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const parts = t.split(/\s*,\s*/).filter((seg) => {
    const k = seg.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return parts.join(", ");
}

function decodeBasicEntities(s: string): string {
  return s.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  rupee: "₹", yen: "¥", times: "×", deg: "°", eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í",
  oacute: "ó", uacute: "ú", ntilde: "ñ", ouml: "ö", uuml: "ü", auml: "ä", szlig: "ß", ccedil: "ç", zwj: "", zwnj: "",
};

/** every named entity we know, plus all decimal / hex numeric ones; unknown names stay as they are */
function decodeAllEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}
