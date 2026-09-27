/**
 * JD → prompt text (§4 Customize). Generation used to get the first 1,200 raw chars of
 * `jdText` — for a Greenhouse posting that is HTML tags + "About <Company>" boilerplate,
 * and the requirements start ~3k chars in. This turns the JD into plain text, splits it
 * on its headings, drops sections that never help tailoring (benefits, EEO, privacy),
 * and puts what the role asks for first. Pure + heuristic; a JD with no headings passes
 * through as cleaned text.
 */

export type JdSectionKind = "role" | "other" | "company" | "drop";

export interface JdSection {
  heading: string | null;
  kind: JdSectionKind;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → text that keeps structure: headings become `## ` lines, list items `- `. */
export function jdHtmlToText(html: string): string {
  // some boards double-escape their HTML (&lt;p&gt;…)
  const src = /&lt;\/?(p|div|li|ul|h\d|br|strong)\b/i.test(html) ? decode(html) : html;
  return decode(
    src
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t: string) => `\n## ${t.replace(/<[^>]+>/g, "").trim()}\n`)
      // a paragraph that is only bold text is a heading on most boards
      .replace(/<p[^>]*>\s*<(strong|b)>([^<]{2,80})<\/\1>\s*(<br\s*\/?>)?\s*<\/p>/gi, (_m, _b, t: string) => `\n## ${t.trim()}\n`)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|ul|ol|section|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

const DROP_RE =
  /\b(benefits?|perks|what we offer|we offer|equal (employment )?opportunit\w*|eeo|diversity|inclusion|accommodations?|privacy|how to apply|application process|pay (range|transparency)|compensation|salary|total rewards|candidate experience|disclaimer|recruitment fraud|job category)\b/i;
const ROLE_RE =
  /\b(requirements?|qualifications?|must[- ]haves?|nice[- ]to[- ]haves?|preferred|bonus points|skills?|experience|responsibilit\w*|what you('|’)?ll|what you will|you will|you('|’)?ll|who you are|about you|you have|you bring|you are|your (role|impact|day)|in this role|the role|about the (role|team|job|position|opportunity)|the team|the opportunity|day[- ]to[- ]day|key job|basic|minimum|we('|’)?re looking for|looking for|look for|ideal candidate|tech stack|what we('|’)?re looking)\b/i;
const COMPANY_RE = /\b(about|who we are|our (mission|story|values|culture|team)|mission|life at|why|culture)\b/i;

function classify(heading: string | null): JdSectionKind {
  if (!heading) return "other";
  if (DROP_RE.test(heading)) return "drop";
  if (ROLE_RE.test(heading)) return "role";
  if (COMPANY_RE.test(heading)) return "company";
  return "other";
}

/** Whole-line headings plain-text boards use without a trailing colon. Anchored, so a
 *  bulletless list line like "Experience with Kafka" is NOT mistaken for a heading. */
const BARE_HEADING_RE = new RegExp(
  "^(" +
    [
      "about( us| you| the (role|team|job|position|opportunity|company))?",
      "about [\\w.&'’-]+( [\\w.&'’-]+)?",
      "who we are", "who you are", "what you('|’)?ll (do|need|bring|work on)", "what you will (do|need|bring)",
      "what we('|’)?re looking for", "what we look for", "what we offer", "why join( us)?", "why [\\w.&-]+",
      "(key )?(job )?responsibilities", "roles? (and|&) responsibilities", "requirements", "job requirements",
      "(minimum|basic|preferred|required|desired) (requirements|qualifications|skills|experience)",
      "qualifications", "nice to haves?", "good to have", "bonus points", "benefits", "perks( (and|&) benefits)?",
      "the role", "the team", "the opportunity", "your role", "your impact", "in this role", "role overview",
      "a day in the life", "day to day", "tech stack", "skills( (and|&) (experience|qualifications))?", "experience",
      "our (mission|story|values|culture)", "life at [\\w.&-]+", "equal (employment )?opportunity.*",
      "job (description|summary|overview)", "position (summary|overview)", "overview", "summary",
    ].join("|") +
    ")$",
  "i",
);

/** A plain-text line that reads as a section heading ("About Paytm:", "Minimum requirements"). */
function headingOf(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("## ")) return t.slice(3).replace(/:$/, "").trim() || null;
  if (t.length < 3 || t.length > 70 || /^[-•*]/.test(t)) return null;
  // "About Paytm:" / "In this role, you will:" — short line ending in a colon
  if (/:$/.test(t) && t.split(/\s+/).length <= 9) return t.slice(0, -1).trim();
  return BARE_HEADING_RE.test(t) ? t : null;
}

/** Split cleaned JD text into headed sections, each classified. */
export function jdSections(jdText: string): JdSection[] {
  const text = (/<[a-z][^>]*>/i.test(jdText) || /&lt;[a-z]/i.test(jdText) ? jdHtmlToText(jdText) : jdText)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ");
  const sections: JdSection[] = [];
  let cur: JdSection = { heading: null, kind: "other", text: "" };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = headingOf(line);
    if (h) {
      if (cur.text.trim() || cur.heading) sections.push(cur);
      cur = { heading: h, kind: classify(h), text: "" };
      continue;
    }
    cur.text += (cur.text ? "\n" : "") + line;
  }
  if (cur.text.trim() || cur.heading) sections.push(cur);
  // a heading with nothing under it (a "Job Details" wrapper) carries no content
  return sections.filter((s) => s.text.trim());
}

/**
 * The JD as a model should read it: role sections (requirements, responsibilities)
 * first, then untitled/other text, then company context if there's room; benefits /
 * EEO / privacy dropped. Truncated at a line boundary to `maxChars`.
 */
export function jdForPrompt(jdText: string, maxChars = 4000): string {
  if (!jdText?.trim()) return "";
  const sections = jdSections(jdText);
  const order: JdSectionKind[] = ["role", "other", "company"];
  const parts: string[] = [];
  for (const kind of order) {
    for (const s of sections) {
      if (s.kind !== kind) continue;
      parts.push(s.heading ? `${s.heading}:\n${s.text}` : s.text);
    }
  }
  const out = parts.join("\n\n").trim();
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return `${(nl > maxChars * 0.6 ? cut.slice(0, nl) : cut).trimEnd()}\n…`;
}
