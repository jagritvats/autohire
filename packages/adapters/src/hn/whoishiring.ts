import type { RawPosting, SearchQuery } from "@jobflow/core";
import { classifyLink, extractLinks, parseLocation } from "@jobflow/core";
import { atsCandidates } from "../detector/index.js";
import { httpJson, type FetchTarget, type SearchCaps, type SearchTargetContext, type SourceAdapter } from "../types.js";
import { queryTerms } from "../search.js";

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


export class HnWhoIsHiringAdapter implements SourceAdapter {
  readonly source = "hn_whoishiring" as const;
  readonly tier = "tier1" as const;
  readonly searchCaps: SearchCaps = {
    keywords: true, location: false, country: false, remote: false, postedWithin: false, salaryMin: false, seniority: false, cost: "free",
  };

  /** the month's thread, filtered by each term (a keyword filter over the comments). */
  toTargets(q: SearchQuery, _ctx: SearchTargetContext): FetchTarget[] {
    return queryTerms(q).map((term) => ({ query: term, limit: 60 }));
  }

  async fetch(target: FetchTarget): Promise<RawPosting[]> {
    // a specific thread (custom `hn_thread` source), else the latest "Who is hiring?"
    const storyId = target.params?.storyId != null ? String(target.params.storyId).replace(/\D/g, "") : "";
    let story: { objectID: string; created_at: string } | undefined;
    if (storyId) {
      story = { objectID: storyId, created_at: "" };
    } else {
      const search = await httpJson<HnSearchResp>(
        "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=3",
      );
      story = (search?.hits ?? []).find((h) => /who is hiring/i.test(h.title));
    }
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
      const company = deriveCompany(text);
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

const ROLE_HINT = /\b(engineers?|developers?|sde|swe|backend|back-end|frontend|front-end|full[- ]?stack|platform|sre|devops|staff|senior|principal|lead|scientists?|researchers?|designers?|architects?|interns?|internships?|member of technical staff|roles|positions|openings)\b/i;

/**
 * Segment separators on the lede: pipes, or a dash/bullet with spaces around it — never
 * a hyphen inside a word ("non-profit" split "Enveritas (YC S18, non-profit)").
 */
const SEGMENT_SEP = /\s*\|\s*|\s+[-–—•·]\s+/;

/** work-mode / contract / pay segments ("Remote (US)", "Full-time", "$150k") */
const MODE_SEGMENT = /\b(remote|onsite|on[- ]site|hybrid|in[- ]person|full[- ]time|part[- ]time|contract(or)?|visa|relocation|hiring)\b|[$€£]|\b\d+(?:\.\d+)?\s*k\b|\b\d{2,3},\d{3}\b/i;
/** places core's location parser doesn't know (it only needs to recognise, not geocode) */
const EXTRA_PLACES = /\b(pakistan|switzerland|sweden|norway|denmark|finland|italy|austria|belgium|czechia|czech republic|romania|greece|israel|japan|singapore|australia|new zealand|brazil|mexico|argentina|colombia|chile|nigeria|kenya|egypt|turkey|uae|dubai|vietnam|philippines|indonesia|malaysia|thailand|korea|taiwan|estonia|ukraine|hungary|bulgaria|serbia|croatia|lithuania|latvia|luxembourg|cologne|hamburg|zurich|geneva|stockholm|copenhagen|oslo|helsinki|vienna|prague|budapest|tallinn|milan|rome|tokyo|sydney|melbourne|tel aviv)\b/i;
const MULTIWORD_CITY = /^(new york( city)?|san francisco|bay area|los angeles|san diego|san jose|salt lake city|hong kong|tel aviv|sao paulo|são paulo|mexico city|buenos aires|kuala lumpur|new delhi|washington,? d\.?c\.?)(,\s*[a-z. ]+)?$/i;
/** comments that aren't job posts ("I've created a page to navigate this thread") */
const META_LEDE = /^(i|i've|i'm|i made|i built|i created|shameless plug|not hiring)\b/i;
const CORP_SUFFIX = /^(inc|llc|ltd|gmbh|corp|co|bv|ag|sa|plc)\.?$/i;
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|yahoo|proton|protonmail|icloud|pm|hey|fastmail)$/i;
const GENERIC_HOST = /(^|\.)(github\.com|gitlab\.com|notion\.site|notion\.so|medium\.com|substack\.com|google\.com|ycombinator\.com|calendly\.com|typeform\.com|jotform\.com|tally\.so|airtable\.com|lu\.ma)$/i;
/** a "Who wants to be hired" résumé posted in the hiring thread by mistake */
const SEEKER_POST = /^\s*(willing to relocate|résumé\/cv|resume\/cv|right to work)\s*:/im;

/**
 * The convention is "Company | Role | Location | …", but ~2% of posts break it: they
 * lead with a location ("NYC | ONSITE …"), a role ("Senior Python Engineer | Remote"),
 * or prose ("Beacon AI builds …", "At Tether we're hiring"). The company is the first
 * segment that's neither a role, a place nor a sentence; failing that, a name pulled
 * from the prose, then the apply link / email domain. Empty = not a job post (skipped).
 */
export function deriveCompany(text: string): string {
  const line = (text.split("\n")[0] ?? "").trim();
  if (META_LEDE.test(line) || SEEKER_POST.test(text)) return "";
  const segs = line.split(SEGMENT_SEP).map(cleanSegment).filter(Boolean);
  for (const s of segs) {
    // prose first: a sentence can mention a role or "$30 trillion" and still name the company
    if (isProse(s)) {
      const named = companyFromProse(s);
      if (named) return named;
      continue;
    }
    if (ROLE_HINT.test(s) || isPlace(s) || MODE_SEGMENT.test(s)) continue;
    return stripTrailingPlace(s);
  }
  // "Rust developer at NLnet foundation" — the role segment names the employer
  for (const s of segs) {
    const named = companyFromProse(s);
    if (named) return named;
  }
  return companyFromLinks(text);
}

/** drop "( https://… )", "(YC S18)", bare URLs and "Company:" style labels */
function cleanSegment(seg: string): string {
  let s = seg
    .replace(/\([^)]*\)?/g, " ") // parentheticals, incl. one the lede cut off
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/^\s*(company|employer|location|based in|located in)\s*:\s*/i, (m) => (/company|employer/i.test(m) ? "" : "@@place "))
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim()
    .replace(/[.,;:!]+$/, "");
  if (s.startsWith("@@place")) return ""; // "Location: London, UK"
  // "Remote (US) Close" → "Close": a leading work-mode word glued to a capitalised name
  s = s.replace(/^(?:[Rr]emote|REMOTE|[Oo]nsite|ONSITE|[Oo]n-site|[Hh]ybrid|HYBRID)\s+(?=[A-Z])/, "");
  return s;
}

function isPlace(s: string): boolean {
  if (MULTIWORD_CITY.test(s)) return true;
  const words = s.split(/\s+/);
  // a single token or a "City, Region" / "US/Canada" list: safe to read as a place;
  // "Boston Dynamics" (two words, no comma) is a company that merely contains a city
  const listy = words.length === 1 || /[,/]/.test(s) || /^[A-Z]{2,5}$/.test(s);
  if (!listy) return false;
  const parts = s.split(/\s*[,/]\s*|\s+or\s+|\s+and\s+/i).filter(Boolean);
  return parts.every((p) => {
    if (EXTRA_PLACES.test(p)) return true;
    const loc = parseLocation(p);
    return (loc.country != null || loc.remoteGeo !== "unknown") && loc.confidence >= 0.85;
  });
}

/** "Paul Scherrer Institut, Switzerland" → "Paul Scherrer Institut" */
function stripTrailingPlace(s: string): string {
  const m = s.match(/^(.+?),\s*([^,]+)$/);
  if (!m || CORP_SUFFIX.test(m[2]!.trim())) return s;
  return isPlace(m[2]!.trim()) ? m[1]!.trim() : s;
}

function isProse(s: string): boolean {
  const words = s.split(/\s+/).length;
  return words > 6 || (words > 3 && /\b(we|we're|we are|our|is|are|builds?|helps?|makes?)\b/i.test(s));
}

const NAME = String.raw`[A-Z][\w&.'’-]*(?:\s+[A-Z0-9][\w&.'’-]*){0,3}`;
function companyFromProse(s: string): string {
  const m =
    s.match(new RegExp(String.raw`^[Aa]t\s+(${NAME})`)) ?? // "At Tether we're hiring"
    s.match(new RegExp(String.raw`\bat\s+(${NAME})`)) ?? // "several roles at StudyTurtle, an …"
    s.match(new RegExp(String.raw`^(${NAME})\s+(?:is|are|builds?|helps?|makes?|creates?|develops?|provides?|has|was)\b`)) ?? // "Beacon AI builds …"
    s.match(new RegExp(String.raw`^(${NAME}),\s+(?:a|an|the)\s`)); // "Norm Ai, the agentic law company, …"
  const name = m?.[1]?.replace(/[.,;:!’']+$/, "").trim() ?? "";
  return name && !ROLE_HINT.test(name) && !isPlace(name) && !/^(we|our|the|a|an)$/i.test(name) ? name : "";
}

/** company from the apply link (ATS slug, else the site's domain) or a jobs@ email */
function companyFromLinks(text: string): string {
  const ats = atsCandidates(text).find((c) => !c.slug.includes("/"));
  if (ats) return titleCase(ats.slug.replace(/[-_]+/g, " "));
  for (const url of extractLinks(text)) {
    const { host, kind } = classifyLink(url);
    if (kind !== "other" && kind !== "careers") continue;
    if (!host || GENERIC_HOST.test(host)) continue;
    const label = registrableLabel(host);
    if (label) return titleCase(label);
  }
  const email = text.match(/[\w.+-]+@([\w-]+)\.[a-z.]{2,}/i)?.[1];
  return email && !FREEMAIL.test(email) ? titleCase(email) : "";
}

/** "careers.acme.co.uk" → "acme" */
function registrableLabel(host: string): string {
  const labels = host.split(".");
  const cc2 = labels.length >= 3 && /^(co|com|org|net|ac)$/.test(labels[labels.length - 2]!);
  return labels[labels.length - (cc2 ? 3 : 2)] ?? "";
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveTitle(line: string): string {
  const parts = line.split(SEGMENT_SEP).map((s) => s.trim());
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
