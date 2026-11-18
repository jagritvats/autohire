import type { LevelBand, RoleArchetype } from "../schema/enums.js";

/**
 * Title normalization (§ Normalizer). "Sr. SDE II" → { titleNorm: "software-engineer",
 * level: "senior" }. This is the unglamorous core that everything downstream trusts.
 */

/**
 * Ordered most→least specific; first match wins. Explicit words ("Senior",
 * "Director") beat ladder rungs, so "Sr. SDE II" is senior and "Associate Director"
 * is director. Ladder rungs follow the Indian product-company convention (§11.2):
 * SDE-1 ≈ 0–2 yrs, SDE-2 ≈ 2–5 yrs (mid — the natural target for ~2 YoE), SDE-3 ≈
 * senior; "Engineer I/II/III/IV" reads the same way.
 */
const LADDER = String.raw`(?:sde|swe|engineer|developer|programmer)\s*[-–]?\s*`;
const SENIORITY_PATTERNS: Array<[RegExp, LevelBand]> = [
  [/\b(intern|internship|trainee|apprentice)\b/i, "intern"],
  [/\b(director|vp|vice president|head of|chief)\b/i, "director"],
  [/\b(principal|distinguished|fellow)\b/i, "principal"],
  [/\bstaff\b/i, "staff"],
  [/\b(engineering manager|people manager|manager)\b/i, "manager"],
  [/\b(sr\.?|senior|snr|lead engineer)(?![a-z])/i, "senior"],
  [/\b(tech lead|team lead|engineering lead|lead|s?tl)\b/i, "lead"], // TL / STL = (senior) team lead
  [new RegExp(String.raw`\b${LADDER}(iv|4)\b`, "i"), "staff"],
  [new RegExp(String.raw`\b${LADDER}(iii|3)\b`, "i"), "senior"],
  [new RegExp(String.raw`\b${LADDER}(ii|2)\b`, "i"), "mid"],
  [new RegExp(String.raw`\b${LADDER}(i|1|0)\b`, "i"), "junior"],
  // company L-levels are only roughly comparable; map to the common big-tech reading
  [/\bl3\b/i, "junior"],
  [/\bl4\b/i, "mid"],
  [/\bl5\b/i, "senior"],
  [/\bl[6-7]\b/i, "staff"],
  [/\bmid[ -]?(level|senior)?\b/i, "mid"],
  [/\b(jr\.?|junior|entry[ -]?level|graduate|new grad|grad|fresher|early[ -]career|associate)(?![a-z])/i, "junior"],
];

/**
 * Non-engineering roles whose titles still contain "engineer"/"developer"
 * (Developer Marketing, Developer Relations, Sales Engineer, Solutions Engineer…).
 * Checked FIRST so they don't masquerade as backend roles and pollute the ranking.
 * Stems end in `\w*` (not `\b`) so "Advocate", "Recruiter", "Evangelism" match.
 */
const NON_ENG_TITLE = /\b(market\w*|relations|advocat\w*|evangelis\w*|recruit\w*|talent|sales|account (executive|manager)|accounts? (payable|receivable)|accountant|customer success|support engineer|solutions? (engineer|architect|consultant)|pre[- ]?sales|partnerships?|community|content|copy ?writer|designer|writer|art director|finance|financial|legal|counsel|people|hr\b|operations? (manager|lead|associate|specialist)|business (operations|development|analyst)|(product|program|project) (manager|owner|lead)|specialist|investigator|analyst)\b/i;

const ARCHETYPE_PATTERNS: Array<[RegExp, RoleArchetype]> = [
  [/\b(sre|site reliability)\b/i, "sre"],
  [/\b(devops|platform|infrastructure|infra|cloud engineer|kubernetes)\b/i, "infra_devops"],
  [/\b(data engineer|ml|machine learning|ai engineer|mlops|data scientist|deep learning)\b/i, "data_ml"],
  [/\b(full[ -]?stack)\b/i, "fullstack"],
  [/\b(front[ -]?end|frontend|react|ui engineer)\b/i, "frontend"],
  [/\b(mobile|android|ios|react native|flutter)\b/i, "mobile"],
  [/\b(backend|back[ -]?end|server[ -]?side|api engineer|distributed systems)\b/i, "backend"],
  // web/CMS developers build sites end to end — the far edge of a backend target
  [/\b(web|wordpress|shopify|drupal|webflow) (developer|engineer)\b/i, "fullstack"],
  // Amazon's "Software Development Engineer" / "Software Dev Engineer" carry none of the
  // words below — 500-role boards read as non-engineering without this (audit, 2026-11)
  [/\b(software (development |dev |engineering )?engineer|sde|swe|developer|programmer)\b/i, "backend"],
];

/**
 * The role noun of a title: what comes before the team/domain suffix. "Software Engineer,
 * Financial Business Insights", "Senior Software Engineer - Marketplace" and "Backend
 * Engineer, People Platform" are engineering roles on a finance / marketplace / people TEAM —
 * the non-engineering guard must read the head, or every such title becomes "other".
 */
function titleHead(title: string): string {
  return title.split(/\s*(?:,|\(|\||:|\s[-–—]\s|\s@\s|\bfor\b)\s*/i)[0] ?? title;
}
/** an engineering role noun in the head — then a non-eng word in the suffix is the team. */
const ENG_HEAD = /\b(software|engineer(?:ing)?|developer|sde|swe|programmer|back[ -]?end|front[ -]?end|full[ -]?stack|devops|sre)\b/i;

function isNonEngineeringTitle(title: string): boolean {
  const head = titleHead(title);
  if (NON_ENG_TITLE.test(head)) return true;
  return !ENG_HEAD.test(head) && NON_ENG_TITLE.test(title);
}

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
  if (!isNonEngineeringTitle(title)) {
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

/** phrasings of the same role noun, substituted IN PLACE (the rest of the title is kept). */
const ROLE_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(software (development |dev )?engineer|software developer|sde|swe)\b/gi, "software engineer"],
  [/\b(developer|programmer)\b/gi, "engineer"],
  [/\bback[ -]end\b/gi, "backend"],
  [/\bfront[ -]end\b/gi, "frontend"],
  [/\bfull[ -]stack\b/gi, "fullstack"],
];
/** level spellings → one token each; the level itself STAYS in the key ("Senior PM" ≠ "PM I") */
const LEVEL_SPELLINGS: Array<[RegExp, string]> = [
  [/\b(sr|snr)\b\.?/gi, "senior"],
  [/\bjr\b\.?/gi, "junior"],
  [/\biv\b/gi, "4"],
  [/\biii\b/gi, "3"],
  [/\bii\b/gi, "2"],
  [/\bi\b/gi, "1"],
];
/** words a parenthetical may consist of and still only say where / how / on what terms */
const TAG_WORD = /^(remote|hybrid|onsite|on|site|office|in|wfh|work|from|home|full|part|time|contract|contractor|permanent|temporary|all|genders?|or|and|only|based|[a-z]|india|bengaluru|bangalore|hyderabad|pune|mumbai|chennai|delhi|ncr|gurgaon|gurugram|noida|kolkata|ahmedabad|us|usa|united|states|uk|kingdom|europe|eu|emea|apac|latam|americas|canada|anywhere|worldwide|global|new|york|nyc|sf|san|francisco|london|berlin|toronto|singapore)$/i;
/** a parenthetical that's only a location / work mode / employment / gender tag: "(Remote, US)", "(f/m/d)" */
function isTagOnly(inner: string): boolean {
  const words = inner.toLowerCase().split(/[\s,/|;:+&.-]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => TAG_WORD.test(w));
}

/**
 * The title part of the dedup key (§ Deduper). Unlike `titleNorm` — a COARSE role family
 * ("software-engineer") used for salary comparables — this keeps everything that tells two
 * roles at one company apart: the team ("Software Engineer, Payments" ≠ "Software Engineer,
 * Search"), the specialty and the level ("Senior PM" ≠ "PM II"). Only phrasing noise
 * collapses: level spellings ("Sr." / "Senior", "II" / "2"), "Developer" / "Engineer",
 * "SDE" / "Software Engineer", word order, req ids and location/employment tags. Keying on
 * `titleNorm` merged every "… Software Engineer …" at a company+city into one card (audit
 * 2026-11: 43% of the corpus hidden from ranking). Format: "<levelBand|x>~<sorted tokens>".
 */
export function dedupTitleKey(rawTitle: string): string {
  const { levelBand } = parseTitle(rawTitle);
  let t = rawTitle
    .replace(/\(([^)]*)\)/g, (_m, inner: string) => (isTagOnly(inner) ? " " : ` ${inner} `))
    .replace(/[#@].*$/g, " ") // trailing req ids "#1234", "@ Acme"
    .replace(/\b(job id|req(uisition)?( id)?)\b[^,|]*$/gi, " ")
    .replace(/\b[a-z]{0,4}[-_]?\d{4,}\b/gi, " "); // "AMZ10587293", "R-12345"
  for (const [re, to] of ROLE_SYNONYMS) t = t.replace(re, to);
  for (const [re, to] of LEVEL_SPELLINGS) t = t.replace(re, to);
  t = t.replace(/\b(remote|hybrid|onsite|on-site)\b/gi, " ");
  // tokens, order-insensitive: "Engineer, Backend" and "Backend Engineer" are one role
  const words = slugify(t.replace(/[,\-–—/|:&+.]+/g, " ")).split("-");
  const tokens = [...new Set(words.filter((w) => w && w !== "and" && w !== "the" && w !== "of"))].sort();
  return `${levelBand ?? "x"}~${tokens.join("-")}`;
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
