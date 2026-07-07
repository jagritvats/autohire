import type { LevelBand, RoleArchetype } from "../schema/enums.js";

/**
 * Title normalization (§ Normalizer). "Sr. SDE II" → { titleNorm: "software-engineer",
 * level: "senior" }. This is the unglamorous core that everything downstream trusts.
 */

const SENIORITY_PATTERNS: Array<[RegExp, LevelBand]> = [
  [/\b(intern|internship|trainee|apprentice)\b/i, "intern"],
  [/\b(jr\.?|junior|entry[ -]?level|graduate|associate|sde[ -]?0|sde[ -]?i\b|grad)\b/i, "junior"],
  [/\b(principal|distinguished|fellow)\b/i, "principal"],
  [/\b(staff|sde[ -]?iii|sde[ -]?3|l[5-7])\b/i, "staff"],
  [/\b(sr\.?|senior|snr|sde[ -]?ii\b|sde[ -]?2|lead engineer)\b/i, "senior"],
  [/\b(tech lead|team lead|engineering lead|\blead\b)\b/i, "lead"],
  [/\b(director|vp|head of|chief)\b/i, "director"],
  [/\b(engineering manager|\bem\b|people manager|manager)\b/i, "manager"],
];

/**
 * Non-engineering roles whose titles still contain "engineer"/"developer"
 * (Developer Marketing, Developer Relations, Sales Engineer, Solutions Engineer…).
 * Checked FIRST so they don't masquerade as backend roles and pollute the ranking.
 */
const NON_ENG_TITLE = /\b(marketing|relations|advocat|evangelist|recruit|talent|sales|account (executive|manager)|customer success|support engineer|solutions? engineer|sales engineer|pre[- ]?sales|partnerships?|community|content|designer|writer|finance|legal|people|hr\b|operations? (manager|lead)|program manager)\b/i;

const ARCHETYPE_PATTERNS: Array<[RegExp, RoleArchetype]> = [
  [/\b(sre|site reliability)\b/i, "sre"],
  [/\b(devops|platform|infrastructure|infra|cloud engineer|kubernetes)\b/i, "infra_devops"],
  [/\b(data engineer|ml|machine learning|ai engineer|mlops|data scientist|deep learning)\b/i, "data_ml"],
  [/\b(full[ -]?stack)\b/i, "fullstack"],
  [/\b(front[ -]?end|frontend|react|ui engineer)\b/i, "frontend"],
  [/\b(mobile|android|ios|react native|flutter)\b/i, "mobile"],
  [/\b(backend|back[ -]?end|server[ -]?side|api engineer|distributed systems)\b/i, "backend"],
  [/\b(software engineer|sde|swe|developer|programmer)\b/i, "backend"],
];

/** Words we strip so two postings of the same role collapse to one canonical title.
 *  Seniority is stripped here because it's captured separately in `levelBand` — so
 *  "Sr. Backend Engineer" and "Backend Engineer" share a titleNorm and dedup. */
const NOISE = [
  /\b(sr\.?|snr|senior|jr\.?|junior|staff|principal|lead|mid[ -]?level|entry[ -]?level|associate)\b/gi,
  /\b(ii|iii|iv)\b/gi, // roman level suffixes: SDE II, Engineer III (keeps the role word)
  /\b\d\b/g, // standalone digit level: "SDE 2"
  /\b(remote|hybrid|onsite|on-site)\b/gi,
  /\b(full[ -]?time|part[ -]?time|contract|permanent)\b/gi,
  /\(.*?\)/g, // parentheticals: "(Backend)", "(f/m/d)", "(Remote, US)"
  /\b(f\/m\/d|m\/f\/d|m\/w\/d|d\/f\/m)\b/gi,
  /[#@].*$/g, // trailing req ids "#1234"
  /\b\d+\+?\s*(yrs?|years?)\b/gi,
];

const CANONICAL_MAP: Array<[RegExp, string]> = [
  [/\b(sde|swe|software (development )?engineer|software developer|developer|programmer)\b/i, "software-engineer"],
  [/\bsite reliability\b/i, "site-reliability-engineer"],
  [/\b(devops|platform engineer)\b/i, "platform-engineer"],
  [/\bdata engineer\b/i, "data-engineer"],
  [/\b(ml|machine learning) engineer\b/i, "ml-engineer"],
  [/\bengineering manager\b/i, "engineering-manager"],
];

export interface TitleParse {
  titleNorm: string;
  levelBand: LevelBand | null;
  roleArchetype: RoleArchetype;
}

export function parseTitle(rawTitle: string): TitleParse {
  const title = rawTitle.trim();

  // 1. seniority — first matching pattern wins (ordered most→least specific)
  let levelBand: LevelBand | null = null;
  for (const [re, band] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      levelBand = band;
      break;
    }
  }

  // 2. archetype — non-eng guard wins first (DevRel/Sales Eng aren't backend roles)
  let roleArchetype: RoleArchetype = "other";
  if (!NON_ENG_TITLE.test(title)) {
    for (const [re, arch] of ARCHETYPE_PATTERNS) {
      if (re.test(title)) {
        roleArchetype = arch;
        break;
      }
    }
  }

  // 3. canonical title slug — strip noise, map to a known canonical, else slugify
  let cleaned = title;
  for (const re of NOISE) cleaned = cleaned.replace(re, " ");
  cleaned = cleaned.replace(/[,\-–—/|]+/g, " ").replace(/\s+/g, " ").trim();

  let titleNorm = slugify(cleaned);
  for (const [re, canon] of CANONICAL_MAP) {
    if (re.test(cleaned)) {
      titleNorm = canon;
      break;
    }
  }

  return { titleNorm, levelBand, roleArchetype };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

/** Normalize a company name for the dedup canonical key (§ Deduper). */
export function normCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|technologies|technology|labs|software|systems|pvt|private)\b\.?/g, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
