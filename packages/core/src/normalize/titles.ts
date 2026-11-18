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
 * senior; "Engineer I/II/III/IV" reads the same way, and so does any role noun with a
 * rung ("Data Scientist II", "Analyst 3").
 *
 * Company ladders (docs/architecture.md, "Level bands"): numbered rungs mean different things
 * at different employers, so each mapping is the COMMON reading and carries a lower
 * `levelConfidence` — a source's own level bucket wins over it (`normalizePosting`):
 *   rung I/1 junior · II/2 mid · III/3 senior · IV/4 and V/5 staff
 *   L3 junior · L4 mid · L5 senior · L6–L7 staff · L8+ principal          (Google / Amazon)
 *   E3 junior · E4 mid · E5 senior · E6 staff · E7+ principal             (Meta)
 *   IC1 junior · IC2 mid · IC3–IC4 senior · IC5 staff · IC6+ principal    (generic IC ladders)
 *   ICT2 junior · ICT3 mid · ICT4 senior · ICT5 staff · ICT6+ principal   (Apple)
 *   SMTS senior · LMTS staff · PMTS principal; a bare "Member of Technical Staff" has NO
 *   level (AI labs give every engineer that title) — the JD's years decide.
 * The E / IC forms count only next to a role noun or as a tag ("Software Engineer - E5",
 * "Engineer (IC4)"), never alone: "E5" is also a pay grade.
 */
const ROLE_NOUN = String.raw`(?:sde|swe|engineer|developer|programmer|scientist|analyst|researcher|architect|designer)`;
const LADDER = String.raw`${ROLE_NOUN}\s*[-–]?\s*`;
/** a company-ladder code: after a role noun, a comma / dash, or inside parentheses */
const tagged = (code: string) => new RegExp(String.raw`(?:${ROLE_NOUN}\s*[-–,]?\s*|[,(]\s*|\s[-–|]\s*)(?:${code})\b`, "i");

type LevelRule = [RegExp, LevelBand, number];
const SENIORITY_PATTERNS: LevelRule[] = [
  [/\b(intern|internship|trainee|apprentice)\b/i, "intern", 0.95],
  [/\b(director|vp|vice president|head of|chief)\b/i, "director", 0.95],
  [/\b(principal|distinguished|fellow|pmts)\b/i, "principal", 0.9],
  // the Salesforce-style MTS ladder, before "staff" (which "Member of Technical Staff" contains)
  [/\blmts\b|\blead member of (the )?technical staff\b/i, "staff", 0.7],
  [/\bsmts\b|\b(senior|sr\.?) member of (the )?technical staff\b/i, "senior", 0.7],
  [/(?<!\bmember of (?:the )?technical )\bstaff\b/i, "staff", 0.9],
  [/\b(engineering manager|people manager|manager)\b/i, "manager", 0.9],
  [/\b(sr\.?|senior|snr|lead engineer)(?![a-z])/i, "senior", 0.9],
  [/\b(tech lead|team lead|engineering lead|lead|s?tl)\b/i, "lead", 0.85], // TL / STL = (senior) team lead
  [new RegExp(String.raw`\b${LADDER}(iv|4|v|5)\b`, "i"), "staff", 0.6],
  [new RegExp(String.raw`\b${LADDER}(iii|3)\b`, "i"), "senior", 0.7],
  [new RegExp(String.raw`\b${LADDER}(ii|2)\b`, "i"), "mid", 0.7],
  [new RegExp(String.raw`\b${LADDER}(i|1|0)\b`, "i"), "junior", 0.7],
  // company L-levels are only roughly comparable; map to the common big-tech reading
  [/\bl3\b/i, "junior", 0.6],
  [/\bl4\b/i, "mid", 0.6],
  [/\bl5\b/i, "senior", 0.6],
  [/\bl[6-7]\b/i, "staff", 0.6],
  [/\bl(8|9|10)\b/i, "principal", 0.55],
  [tagged("e3"), "junior", 0.55],
  [tagged("e4"), "mid", 0.55],
  [tagged("e5"), "senior", 0.55],
  [tagged("e6"), "staff", 0.55],
  [tagged("e[7-9]"), "principal", 0.5],
  [tagged("ic1|ict1"), "junior", 0.5],
  [tagged("ic2"), "mid", 0.5],
  [tagged("ict2"), "junior", 0.5],
  [tagged("ict3"), "mid", 0.5],
  [tagged("ic3|ic4|ict4"), "senior", 0.5],
  [tagged("ict?5"), "staff", 0.5],
  [tagged("ict?[6-9]"), "principal", 0.5],
  [/\bmid[ -]?(level|senior)?\b/i, "mid", 0.85],
  [/\b(jr\.?|junior|entry[ -]?level|graduate|new grad|grad|fresher|early[ -]career|associate)(?![a-z])/i, "junior", 0.85],
];

/**
 * Data / analytics roles ("Data Analyst", "Analytics Engineer", "BI Developer", "Product
 * Analyst", "Statistician"): their own archetype, `data_analytics`, read from the title's
 * head before the non-engineering guard — which filed every "… Analyst" under `other` (76 of
 * 82 analyst titles on a US corpus, 2026-11 feed review). "Business Analyst", "Financial
 * Analyst", "Security Analyst" and quant roles are not analytics roles here.
 */
const DATA_ANALYTICS_RE =
  /\b((data|analytics|bi|business intelligence|reporting|insights?|product|marketing|growth|web|digital|people|hr|customer|decision|commercial|revenue)\s+(analyst|analytics)|analytics\s+(engineer|developer|analyst|specialist|consultant|lead|manager|intern|associate)|(bi|business intelligence)\s+(engineer|developer|architect|specialist|consultant|lead|manager)|data\s+analytics|data\s+visuali[sz]ation|(tableau|power ?bi|looker)\s+(developer|engineer|analyst|consultant)|statisticians?)s?\b/i;
/** "Data Center Operations Analyst" is facilities work, not a data role */
const NOT_DATA_RE = /\bdata\s*cent(er|re)s?\b/i;
/** ML / data-engineering nouns: they keep a title in `data_ml` even when it says "analytics" */
const DATA_ML_RE = /\b(data engineer(ing)?|ml|machine learning|ai engineer|mlops|data scientists?|data science|deep learning)\b/i;

/** is this title a data / analytics role (`data_analytics`)? */
export function isDataAnalyticsTitle(title: string): boolean {
  return DATA_ANALYTICS_RE.test(title) && !NOT_DATA_RE.test(title) && !DATA_ML_RE.test(titleHead(title));
}

/**
 * Non-engineering roles whose titles still contain "engineer"/"developer"
 * (Developer Marketing, Developer Relations, Sales Engineer, Solutions Engineer…).
 * Checked FIRST so they don't masquerade as backend roles and pollute the ranking.
 * Stems end in `\w*` (not `\b`) so "Advocate", "Recruiter", "Evangelism" match.
 * The role NOUN wins over a tech modifier: "Executive Assistant - Developer Platform",
 * "Learning Platform & Customer Education Administrator", "Customer Support Developer" and
 * "Developer Success Engineer" are assistant / admin / support / success roles, not
 * platform or backend engineering (2026-11 feed review).
 */
const NON_ENG_TITLE = /\b(market\w*|relations|advocat\w*|evangelis\w*|recruit\w*|talent|sales|account (executive|manager)|accounts? (payable|receivable)|accountant|(customer|developer|partner|client) success|success (engineer|manager|lead|specialist)|support|assistant|administrator|coordinator|receptionist|solutions? (engineer|architect|consultant)|pre[- ]?sales|partnerships?|community|content|copy ?writer|designer|writer|art director|finance|financial|legal|counsel|people|hr\b|operations? (manager|lead|associate|specialist)|business (operations|development|developer|analyst)|(product|program|project) (manager|owner|lead)|specialist|investigator|analyst)\b/i;
/** systems administration IS infrastructure work: that "administrator" is not a non-eng noun */
const SYSADMIN_RE = /\b((cloud|kubernetes|k8s|linux|unix|systems?|database|devops|infrastructure) administrator|sysadmin|dba)\b/i;

const ARCHETYPE_PATTERNS: Array<[RegExp, RoleArchetype]> = [
  [/\b(sre|site reliability)\b/i, "sre"],
  [/\b(devops|platform|infrastructure|infra|cloud engineer|kubernetes|sysadmin|(cloud|k8s|linux|unix|systems?|database|devops|infrastructure) administrator|dba)\b/i, "infra_devops"],
  [DATA_ML_RE, "data_ml"],
  [/\b(full[ -]?stack)\b/i, "fullstack"],
  [/\b(front[ -]?end|frontend|react|ui engineer)\b/i, "frontend"],
  [/\b(mobile|android|ios|react native|flutter)\b/i, "mobile"],
  [/\b(backend|back[ -]?end|server[ -]?side|api engineer|distributed systems)\b/i, "backend"],
  // web/CMS developers build sites end to end — the far edge of a backend target
  [/\b(web|wordpress|shopify|drupal|webflow) (developer|engineer)\b/i, "fullstack"],
  // Amazon's "Software Development Engineer" / "Software Dev Engineer" carry none of the
  // words below — 500-role boards read as non-engineering without this (audit, 2026-11)
  [/\b(software (development |dev |engineering )?engineer|sde|swe|developer|programmer)\b/i, "backend"],
  // "SW Engineer II", "Software Engineering Intern / Senior Associate" (audit 2026-11, 4th pass)
  [/\b(sw engineer|software engineering (intern|associate|senior associate|graduate|apprentice))\b/i, "backend"],
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
const ENG_HEAD = /\b(software|engineer(?:ing)?|developer|sde|swe|programmer|back[ -]?end|front[ -]?end|full[ -]?stack|devops|sre|scientist|analytics|machine learning|ml)\b/i;

function isNonEngineeringTitle(title: string): boolean {
  const head = titleHead(title);
  if (SYSADMIN_RE.test(head)) return false;
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
  [/\b(sde|swe|sw engineer|software (development )?engineer|software developer|developer|programmer)\b/i, "software-engineer"],
  [/\bsite reliability\b/i, "site-reliability-engineer"],
  [/\b(devops|platform engineer)\b/i, "platform-engineer"],
  [/\bdata engineer\b/i, "data-engineer"],
  [/\b(ml|machine learning) engineer\b/i, "ml-engineer"],
  [/\bengineering manager\b/i, "engineering-manager"],
];

export interface TitleParse {
  titleNorm: string;
  levelBand: LevelBand | null;
  /**
   * how much the band is worth, 0..1 (0 when there is none): an explicit word ("Senior",
   * "Intern") 0.85–0.95; a ladder rung ("Engineer II") 0.6–0.7; a company ladder code ("L5",
   * "E5", "IC4") 0.5–0.6, because those mean different things at different employers.
   */
  levelConfidence: number;
  roleArchetype: RoleArchetype;
}

export function parseTitle(rawTitle: string): TitleParse {
  const title = rawTitle.trim();

  // 1. seniority — first matching pattern wins (ordered most→least specific)
  let levelBand: LevelBand | null = null;
  let levelConfidence = 0;
  for (const [re, band, conf] of SENIORITY_PATTERNS) {
    if (re.test(title)) {
      levelBand = band;
      levelConfidence = conf;
      break;
    }
  }

  // 2. archetype — a data / analytics head noun first ("Data Analyst", "BI Developer"),
  //    then the non-eng guard (DevRel, Sales Eng, an assistant on a platform team aren't
  //    engineering), then the engineering patterns
  let roleArchetype: RoleArchetype = "other";
  if (isDataAnalyticsTitle(titleHead(title))) roleArchetype = "data_analytics";
  else if (!isNonEngineeringTitle(title)) {
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

  // an analytics team named only in the suffix ("Senior Manager, Data Analytics") when no
  // engineering pattern matched and the head isn't itself a non-engineering role
  if (roleArchetype === "other" && isDataAnalyticsTitle(title) && !NON_ENG_TITLE.test(titleHead(title))) roleArchetype = "data_analytics";

  // the canonical engineering families only for engineering roles: "Developer Advocate",
  // "Executive Assistant - Developer Platform" and "BI Developer" are not "software-engineer"
  // (titleNorm groups salary comparables)
  let titleNorm = slugify(cleaned);
  const engineering = roleArchetype !== "other" && roleArchetype !== "data_analytics";
  for (const [re, canon] of CANONICAL_MAP) {
    if ((engineering || !/software|platform|site reliability|^ml/.test(canon)) && re.test(cleaned)) {
      titleNorm = canon;
      break;
    }
  }

  return { titleNorm, levelBand, levelConfidence, roleArchetype };
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
