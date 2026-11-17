import type { ResumeRole } from "../schema/resume.js";
import { parseTitle } from "../normalize/titles.js";
import { findDateRange } from "./dates.js";
import { bulletText, isBulletLine } from "./text.js";

/**
 * Experience-section parsing: group lines into roles (header lines + their bullets),
 * pull the date range, and split the rest into title / company. Handles the common
 * layouts — "Title, Company — Jan 2023 – Present", "Company  July 2023 – Present" with the
 * title on the next line, "Title | Dates | Company | Place" (LaTeX templates), "Title at
 * Company", markdown "### Title @ Company". Text is copied, never reworded.
 */

const ROLE_WORDS =
  /\b(engineer(ing)?|developer|intern(ship)?|manager|analyst|scientist|designer|architect|consultant|lead|director|programmer|administrator|specialist|associate|sde|swe|sre|founder|co-founder|researcher|assistant|officer|head|vp|cto|ceo|coo|devops|technician|trainee|apprentice|fellow|contractor|freelancer?|tester|qa|owner|mts|member of technical staff|staff|principal|teaching assistant)\b/i;
const COUNTRY =
  /^(India|USA|US|U\.S\.A?\.?|UK|United States|United Kingdom|England|Germany|Canada|Netherlands|France|Spain|Portugal|Ireland|Poland|Singapore|Australia|New Zealand|Japan|UAE|United Arab Emirates|Israel|Brazil|Mexico)$/;
/** "Remote", "(Hybrid)", "Austin, TX", "Bengaluru, India" — a place, not a title or company. */
function isLocationOnly(s: string): boolean {
  if (/^\(?(remote|hybrid|on[- ]?site|in[- ]office|wfh)\)?$/i.test(s)) return true;
  const m = /^([\p{Lu}][\p{L}.'-]*(?: [\p{Lu}][\p{L}.'-]*){0,2}), ?([^,]+?)(?: \((?:remote|hybrid|on[- ]?site)\))?$/u.exec(s);
  if (!m || ROLE_WORDS.test(m[1]!)) return false;
  return /^[A-Z]{2}$/.test(m[2]!) || COUNTRY.test(m[2]!);
}
const EMPLOYMENT_TYPE = /^\(?(full[- ]?time|part[- ]?time|contract|freelance|permanent|temporary|self[- ]employed)\)?$/i;
const CORP_SUFFIX = /^(inc|llc|ltd|limited|gmbh|corp|corporation|co|plc|pvt\.? ltd|llp|sa|ag|bv)\.?$/i;
/** "Tech: Java, Kafka" / "Stack — Go" lines carry content, not role identity. */
const TECH_LINE = /^(tech(nologies|nology| stack)?( used)?|stack|tools|skills|environment)\s*[:—–-]\s*\S/i;
const SEGMENT_SPLIT = /\s+[|•·]\s+|\s*\|\s*|\s+[—–]\s+|\s+-\s+|\s+@\s+|\s+at\s+|\s{3,}/;

interface Group {
  headers: string[];
  bullets: string[];
}

function cleanSegment(s: string): string {
  return s
    .replace(/^[\s,;:|–—-]+|[\s,;:|–—-]+$/g, "")
    .replace(/\s*\((remote|hybrid|on[- ]?site)\)\s*$/i, "")
    .replace(/(?<=\S),\s*(remote|hybrid|on[- ]?site)$/i, "")
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
}

function segmentsOf(line: string): string[] {
  return line
    .split(SEGMENT_SPLIT)
    .map(cleanSegment)
    .filter((s) => s && !isLocationOnly(s) && !EMPLOYMENT_TYPE.test(s) && !/^\(?\s*\)?$/.test(s));
}

/** Group lines into header-lines-then-bullets blocks. */
function groupLines(lines: string[]): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasBullet = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const numbered = /^\d{1,2}[.)]\s+\S/.test(line) && !findDateRange(line);
    if (isBulletLine(line) || numbered || (TECH_LINE.test(line) && cur)) {
      cur ??= { headers: [], bullets: [] };
      cur.bullets.push(isBulletLine(line) ? bulletText(line) : line.replace(/^\d{1,2}[.)]\s+/, ""));
      lastWasBullet = true;
      continue;
    }
    // a wrapped bullet: continues lower-case (or with a closing fragment) after a bullet
    if (lastWasBullet && cur && cur.bullets.length && (/^[a-z(&,;]/.test(line) || (/^\d/.test(line) && !findDateRange(line)))) {
      cur.bullets[cur.bullets.length - 1] += ` ${line}`;
      continue;
    }
    if (!cur || lastWasBullet) {
      cur = { headers: [], bullets: [] };
      groups.push(cur);
    }
    cur.headers.push(line);
    lastWasBullet = false;
  }
  if (cur && !groups.includes(cur)) groups.push(cur);
  // a block of header lines with several date lines and no bullets between them is
  // several roles: each date line starts one, following non-date lines attach to it
  return groups.flatMap((g) => {
    const dated = g.headers.map((h) => !!findDateRange(h));
    if (dated.filter(Boolean).length < 2) return [g];
    const out: Group[] = [];
    let part: Group | null = null;
    g.headers.forEach((h, i) => {
      if (dated[i] || !part) {
        // a leading undated line (company) belongs to the first role
        if (dated[i] && part && out.length === 1 && !part.headers.some((x) => findDateRange(x))) {
          part.headers.push(h);
          return;
        }
        part = { headers: [h], bullets: [] };
        out.push(part);
      } else part.headers.push(h);
    });
    const last = out[out.length - 1];
    if (last) last.bullets = g.bullets;
    return out;
  });
}

/** Title/company from a role's header lines (date range removed). */
function titleCompany(headers: string[]): { title: string; company: string; companyOnOwnLine: boolean } {
  let segs: string[] = [];
  let companyOnOwnLine = false;
  for (const h of headers) {
    const range = findDateRange(h);
    const line = range ? `${h.slice(0, range.index)} | ${h.slice(range.index + range.raw.length)}` : h;
    const s = segmentsOf(line);
    if (headers.length > 1 && !range && s.length === 1 && !ROLE_WORDS.test(s[0]!)) companyOnOwnLine = true;
    segs.push(...s);
  }
  // a lone "Title, Company" segment
  if (segs.length === 1 && segs[0]!.includes(", ")) {
    const [a, ...rest] = segs[0]!.split(", ");
    const b = rest.join(", ");
    if (!CORP_SUFFIX.test(b.trim())) segs = [a!, b];
  }
  // "Title (Company)" — rare, but keep the parenthetical as the company only if no other
  segs = segs.filter((s) => s.length <= 120);
  const titleIdx = segs.findIndex((s) => ROLE_WORDS.test(s));
  if (titleIdx >= 0) {
    const title = segs[titleIdx]!;
    const company = segs.find((_s, i) => i !== titleIdx) ?? "";
    return { title, company, companyOnOwnLine };
  }
  return { title: segs[0] ?? "", company: segs[1] ?? "", companyOnOwnLine };
}

/** Parse experience-section lines into roles. */
export function parseRoles(lines: string[]): ResumeRole[] {
  const roles: ResumeRole[] = [];
  let lastCompany = "";
  let lastCompanyOwnLine = false;
  for (const g of groupLines(lines)) {
    const range = g.headers.map(findDateRange).find((r) => r) ?? null;
    if (!range && g.bullets.length === 0) continue;
    if (g.headers.length === 0) {
      // bullets with no header: attach to the previous role (a wrapped list)
      const prev = roles[roles.length - 1];
      if (prev) prev.bullets.push(...g.bullets);
      continue;
    }
    let { title, company, companyOnOwnLine } = titleCompany(g.headers);
    if (!title && !company) continue;
    if (!company && lastCompanyOwnLine && lastCompany && ROLE_WORDS.test(title)) company = lastCompany;
    const parsed = parseTitle(title);
    roles.push({
      title,
      company,
      start: range?.start ?? null,
      end: range?.end ?? null,
      current: range?.current ?? false,
      bullets: g.bullets,
      levelBand: parsed.levelBand,
      archetype: parsed.roleArchetype,
    });
    if (company) {
      lastCompany = company;
      lastCompanyOwnLine = companyOnOwnLine;
    }
  }
  return roles;
}
