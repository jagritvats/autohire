/**
 * Resilient HTML/JSON extraction helpers shared by the Tier-3 parsers (§7.1). These
 * run on the LOCAL agent over HTML already rendered in the user's session. The whole
 * design principle here is DEFENSIVE: Tier-3 sites are scrape-hostile and their markup
 * churns, so every extractor returns empty/null on failure (never throws) and we anchor
 * on the most stable signals available (JSON-LD, embedded app-state JSON, stable data-
 * attributes) with DOM/regex fallbacks. Callers layer strategies and take the first hit.
 */

/** JSON.parse that never throws — returns null on malformed input. */
export function tryParseJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Flatten a parsed JSON-LD value into its top-level objects, expanding `@graph`. */
export function flattenJsonLd(parsed: unknown): Record<string, unknown>[] {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed.flatMap(flattenJsonLd);
  if (typeof parsed === "object") {
    const graph = (parsed as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) return graph.flatMap(flattenJsonLd);
    return [parsed as Record<string, unknown>];
  }
  return [];
}

/** All `<script type="application/ld+json">` objects in the document (graph-expanded). */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? "").trim();
    if (!raw) continue;
    out.push(...flattenJsonLd(tryParseJson(raw)));
  }
  return out;
}

/** True if a JSON-LD node is (or includes) the given `@type`. */
export function isJsonLdType(node: Record<string, unknown>, type: string): boolean {
  const t = node["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** JSON-LD nodes of a given `@type` (e.g. "JobPosting", "AggregateRating"). */
export function jsonLdOfType(html: string, type: string): Record<string, unknown>[] {
  return extractJsonLd(html).filter((o) => isJsonLdType(o, type));
}

/** Parse a `<script id="__NEXT_DATA__">` blob (Next.js apps embed their props here). */
export function extractNextData(html: string): Record<string, unknown> | null {
  const m = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  return m ? tryParseJson<Record<string, unknown>>((m[1] ?? "").trim()) : null;
}

/**
 * Extract a JS-assigned JSON object literal — `window.__X__ = { … }` / `"apolloState": { … }`.
 * `marker` must match up to (and not past) the opening `{`. Slices a brace-balanced,
 * string-aware substring and JSON-parses it. Returns null if absent/malformed.
 */
export function extractAssignedJson(html: string, marker: RegExp): Record<string, unknown> | null {
  const m = marker.exec(html);
  if (!m) return null;
  const from = html.indexOf("{", m.index + m[0].length - 1);
  if (from < 0) return null;
  const slice = sliceBalancedBraces(html, from);
  return slice ? tryParseJson<Record<string, unknown>>(slice) : null;
}

/** Return the brace-balanced substring starting at `html[from] === '{'` (string/escape aware). */
export function sliceBalancedBraces(html: string, from: number): string | null {
  if (html[from] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (inStr) {
      if (c === "\\") i++; // skip escaped char
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return html.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * Depth-first collect every nested object in a parsed JSON tree that satisfies
 * `predicate`. The workhorse for embedded app-state: it finds job/rating tuples by
 * SHAPE regardless of their exact path, so it survives the site restructuring its
 * state key layout. Cycle-safe and capped.
 */
export function collectObjects(
  root: unknown,
  predicate: (o: Record<string, unknown>) => boolean,
  cap = 1000,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack: unknown[] = [root];
  const seen = new Set<unknown>();
  while (stack.length && out.length < cap) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) if (v && typeof v === "object") stack.push(v);
      continue;
    }
    const o = cur as Record<string, unknown>;
    if (predicate(o)) out.push(o);
    for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
  }
  return out;
}

/** Case-insensitive lookup of the first present key from a candidate list. */
export function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] != null) return o[k];
    // tolerate case / snake variants
    const found = Object.keys(o).find((kk) => kk.toLowerCase() === k.toLowerCase());
    if (found && o[found] != null) return o[found];
  }
  return undefined;
}

export function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Split a document into repeated block matches for a tag+class (a lightweight card splitter). */
export function matchAllGroups(re: RegExp, html: string, cap = 500): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = rx.exec(html)) && out.length < cap) {
    if (m[1] != null) out.push(m[1]);
    if (m.index === rx.lastIndex) rx.lastIndex++; // guard against zero-width loops
  }
  return out;
}

/** Decode the common HTML entities (named + numeric) found in attribute/text values. */
export function decodeEntities(s: string): string {
  if (!s) return "";
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rupee;|&#8377;/gi, "₹");
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** Strip tags → collapsed plain text (for reading a value out of an inner HTML fragment). */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** First capture group of a regex against a string, decoded + trimmed, else null. */
export function firstMatch(re: RegExp, s: string): string | null {
  const m = re.exec(s);
  return m && m[1] != null ? decodeEntities(m[1]).trim() : null;
}
