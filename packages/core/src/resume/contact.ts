import type { Contact } from "../schema/entities.js";
import { matchHeading } from "./sections.js";

/**
 * Contact block extraction. Every value is a verbatim substring of the résumé (URLs lose
 * only their "https://www." prefix) — the form-filler types these into real forms, so
 * nothing is guessed (§7.1, invariant #3).
 */

const EMAIL_RE = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w-])/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[\w%-]+\/?/i;
const GITHUB_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z\d](?:[A-Za-z\d-]{0,38})(?![\w-])(?:\/[\w.-]+)?\/?/i;
const URL_RE = /(?<![@\w.-])(?:https?:\/\/)?(?:[a-z\d-]+\.)+(?:dev|io|me|com|net|org|app|xyz|site|tech|co|in|ai|page|codes|blog|website|example)(?:\/[\w\-./~%#?=&]*)?(?![\w@-])/i;
const PHONE_RE = /(?<![\w/])(\+?\d[\d ().-]{6,}\d)(?![\w/])/g;

/** Header-ish lines a name never comes from. */
const NOT_NAME = /\b(resume|résumé|curriculum vitae|cv|engineer|developer|manager|intern|analyst|scientist|designer|consultant|architect|student|remote|india|usa|contact|email|phone|portfolio|github|linkedin)\b/i;

/** Strip protocol + "www." — the form a person types and the profile stores. */
export function bareUrl(u: string): string {
  return u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/.,;)]+$/, "");
}

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  // a year range "2019-2021" / a date "01/2021" is not a phone number
  if (/^(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}$/.test(candidate.trim())) return false;
  return digits.length >= 10 || /^\+/.test(candidate) || /\(\d+\)/.test(candidate);
}

/** Title-case an ALL-CAPS name ("RILEY SAMPLE" → "Riley Sample"); mixed case untouched. */
function nameCase(s: string): string {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()) : s;
}

/** Does this line look like a person's name: 2–4 capitalised word tokens, no digits/@/URL. */
export function looksLikeName(line: string): boolean {
  const l = line.trim().replace(/^#+\s*/, "");
  if (!l || l.length > 50 || /[\d@/:|•·,;]/.test(l)) return false;
  if (NOT_NAME.test(l) || matchHeading(l)) return false;
  const tokens = l.split(/\s+/);
  if (tokens.length < 1 || tokens.length > 4) return false;
  return tokens.every((t) => /^\p{Lu}[\p{L}'’.-]*$/u.test(t) || /^\p{Lu}\.$/u.test(t));
}

/** Location-like segments in the header: "Austin, TX", "Bengaluru, India", "Remote". */
const LOCATION_SEGMENT = /^[\p{Lu}][\p{L}.'-]*(?: [\p{Lu}][\p{L}.'-]*){0,3}, ?(?:[A-Z]{2}|[\p{Lu}][\p{L}.'-]*(?: [\p{Lu}][\p{L}.'-]*){0,2})$/u;
const REMOTE_SEGMENT = /^remote(?: \([^)]*\)|, [\p{L} ]+)?$/iu;

export interface ParsedContact {
  contact: Partial<Contact>;
  locations: string[];
}

/**
 * Pull contact fields from résumé text. Name, phone and location come only from the
 * header block (the lines before the first section heading, or the first 8 lines);
 * email and profile URLs fall back to the whole text.
 */
export function parseContact(text: string, headerLines?: string[]): ParsedContact {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let header = headerLines;
  if (!header) {
    const firstHeading = lines.findIndex((l) => matchHeading(l));
    header = lines.slice(0, firstHeading > 0 ? Math.min(firstHeading, 12) : 8);
  }
  const headerText = header.join("\n");
  const contact: Partial<Contact> = {};

  const nameLine = header.find(looksLikeName);
  if (nameLine) {
    const name = nameCase(nameLine.trim().replace(/^#+\s*/, ""));
    const [first, ...rest] = name.split(/\s+/);
    contact.firstName = first ?? "";
    contact.lastName = rest.join(" ");
  }

  const email = EMAIL_RE.exec(headerText) ?? EMAIL_RE.exec(text);
  if (email) contact.email = email[0];

  for (const m of headerText.matchAll(PHONE_RE)) {
    if (isPhone(m[1]!)) {
      contact.phone = m[1]!.trim();
      break;
    }
  }

  const li = LINKEDIN_RE.exec(headerText) ?? LINKEDIN_RE.exec(text);
  if (li) contact.linkedin = bareUrl(li[0]);

  const gh = GITHUB_RE.exec(headerText) ?? GITHUB_RE.exec(text);
  if (gh) {
    // the profile, not a repo: github.com/user/repo → github.com/user (a verbatim prefix)
    const bare = bareUrl(gh[0]);
    contact.github = bare.split("/").slice(0, 2).join("/");
  }

  // portfolio: the first other URL in the header (not an email domain / LinkedIn / GitHub)
  const emailDomain = contact.email?.split("@")[1]?.toLowerCase();
  for (const line of header) {
    const scrub = line.replace(new RegExp(EMAIL_RE.source, "g"), " ").replace(new RegExp(LINKEDIN_RE.source, "gi"), " ").replace(new RegExp(GITHUB_RE.source, "gi"), " ");
    const u = URL_RE.exec(scrub);
    if (u && bareUrl(u[0]).toLowerCase() !== emailDomain && /[a-z]/i.test(u[0])) {
      contact.portfolio = bareUrl(u[0]);
      break;
    }
  }

  const locations: string[] = [];
  for (const line of header) {
    if (line === nameLine) continue;
    for (const seg of line.split(/\s*(?:\||•|·|—|–|•|\s-\s|;)\s*/)) {
      const s = seg.trim().replace(/^(location|based in|address)\s*:\s*/i, "");
      if (!s || EMAIL_RE.test(s) || /\d{3}/.test(s) || /\.(com|io|dev|in|org|net|me)\b/i.test(s)) continue;
      if ((LOCATION_SEGMENT.test(s) || REMOTE_SEGMENT.test(s)) && !locations.includes(s)) locations.push(s);
    }
  }
  return { contact, locations };
}
