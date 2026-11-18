import { matchSkillToken } from "../normalize/skills.js";

/**
 * Stack adjacency (§11.1). A Java backend engineer should SEE Go/Kotlin/Scala/Node
 * roles — the transferable core (distributed systems, Kafka, data modelling,
 * concurrency) matters far more than surface language. This hand-tuned graph
 * captures what embeddings get wrong; the semantic score captures the rest.
 *
 * Edges are directional `from → to` transfer weights in [0,1]: "if you know FROM,
 * how cheaply can you do a TO role". Missing edge = use the semantic score alone.
 */

export interface StackEdge {
  from: string;
  to: string;
  weight: number;
}

// Seeded from the spec's §11.1 table, expanded across the backend ecosystem.
export const STACK_EDGES: StackEdge[] = [
  // java as origin (the user's primary)
  { from: "java", to: "kotlin", weight: 0.95 },
  { from: "java", to: "scala", weight: 0.8 },
  { from: "java", to: "csharp", weight: 0.8 },
  { from: "java", to: "go", weight: 0.75 },
  { from: "java", to: "typescript", weight: 0.7 },
  { from: "java", to: "javascript", weight: 0.7 },
  { from: "java", to: "python", weight: 0.68 },
  { from: "java", to: "rust", weight: 0.55 },
  { from: "java", to: "cpp", weight: 0.55 },
  { from: "java", to: "php", weight: 0.5 },
  { from: "java", to: "ruby", weight: 0.5 },
  // ts/node as origin (the user has real TS/Node)
  { from: "typescript", to: "javascript", weight: 0.98 },
  { from: "typescript", to: "go", weight: 0.62 },
  { from: "typescript", to: "python", weight: 0.7 },
  { from: "typescript", to: "java", weight: 0.6 },
  { from: "typescript", to: "php", weight: 0.55 },
  { from: "typescript", to: "ruby", weight: 0.55 },
  // go bridges
  { from: "go", to: "rust", weight: 0.6 },
  { from: "go", to: "java", weight: 0.7 },
  // python bridges
  { from: "python", to: "typescript", weight: 0.68 },
  { from: "python", to: "go", weight: 0.6 },
  { from: "python", to: "ruby", weight: 0.65 },
  { from: "python", to: "php", weight: 0.55 },
  // infra/data skills transfer near-freely once you have the systems core
  { from: "kafka", to: "rabbitmq", weight: 0.85 },
  { from: "kafka", to: "distributed_systems", weight: 0.9 },
  { from: "postgres", to: "mysql", weight: 0.9 },
  { from: "postgres", to: "mongodb", weight: 0.6 },
  { from: "docker", to: "kubernetes", weight: 0.75 },
  { from: "aws", to: "gcp", weight: 0.8 },
  { from: "aws", to: "azure", weight: 0.78 },
  { from: "javascript", to: "typescript", weight: 0.85 },
  // SQL: every relational database implies it; dbt is SQL
  { from: "postgres", to: "sql", weight: 0.9 },
  { from: "mysql", to: "sql", weight: 0.9 },
  { from: "dbt", to: "sql", weight: 0.9 },
  { from: "sql", to: "postgres", weight: 0.7 },
  { from: "sql", to: "mysql", weight: 0.7 },
  { from: "sql", to: "dbt", weight: 0.6 },
  // BI tools are interchangeable for a dashboard role
  { from: "tableau", to: "power_bi", weight: 0.8 },
  { from: "tableau", to: "looker", weight: 0.8 },
  { from: "power_bi", to: "tableau", weight: 0.8 },
  { from: "power_bi", to: "looker", weight: 0.75 },
  { from: "looker", to: "tableau", weight: 0.75 },
  { from: "looker", to: "power_bi", weight: 0.75 },
  // analytics languages
  { from: "pandas", to: "python", weight: 0.9 },
  { from: "python", to: "r", weight: 0.55 },
  { from: "r", to: "python", weight: 0.6 },
  { from: "r", to: "sas", weight: 0.6 },
  { from: "sas", to: "r", weight: 0.6 },
  // frontend frameworks: the framework of a framework you know is near; peers transfer
  { from: "react", to: "nextjs", weight: 0.85 },
  { from: "nextjs", to: "react", weight: 0.95 },
  { from: "vue", to: "nuxt", weight: 0.85 },
  { from: "nuxt", to: "vue", weight: 0.95 },
  { from: "react", to: "vue", weight: 0.7 },
  { from: "vue", to: "react", weight: 0.7 },
  { from: "react", to: "angular", weight: 0.6 },
  { from: "vue", to: "angular", weight: 0.6 },
  { from: "angular", to: "react", weight: 0.65 },
  { from: "angular", to: "vue", weight: 0.65 },
  { from: "react", to: "svelte", weight: 0.7 },
  { from: "vue", to: "svelte", weight: 0.75 },
  { from: "sass", to: "css", weight: 0.95 },
  { from: "css", to: "sass", weight: 0.85 },
  { from: "cypress", to: "playwright", weight: 0.85 },
  { from: "playwright", to: "cypress", weight: 0.85 },
  { from: "jest", to: "playwright", weight: 0.5 },
  { from: "jest", to: "cypress", weight: 0.5 },
  // iOS / Apple and systems languages
  { from: "swiftui", to: "swift", weight: 0.95 },
  { from: "swift", to: "swiftui", weight: 0.8 },
  { from: "objective_c", to: "swift", weight: 0.75 },
  { from: "swift", to: "objective_c", weight: 0.6 },
  { from: "swift", to: "kotlin", weight: 0.55 },
  { from: "kotlin", to: "swift", weight: 0.55 },
  { from: "kotlin", to: "dart", weight: 0.5 },
  { from: "swift", to: "dart", weight: 0.5 },
  { from: "cpp", to: "c", weight: 0.85 },
  { from: "c", to: "cpp", weight: 0.7 },
  { from: "cpp", to: "rust", weight: 0.6 },
];

const LANGUAGES = new Set([
  "java",
  "kotlin",
  "go",
  "scala",
  "rust",
  "csharp",
  "python",
  "typescript",
  "javascript",
  "php",
  "ruby",
  "cpp",
  "c",
  "swift",
  "objective_c",
  "dart",
  "r",
  "sas",
]);

/**
 * Domains the dictionary recognises ("fintech" from payments / ledger / KYC words): what the
 * company DOES, not something a candidate learns. Context, never a gap — the stack note says
 * "you have fintech" when both sides do and never lists it as "new to you" (2026-11 feed review).
 */
const DOMAIN_SKILLS: ReadonlySet<string> = new Set(["fintech_domain"]);

export function isDomainSkill(skill: string): boolean {
  return DOMAIN_SKILLS.has(skill);
}

/**
 * A profile's declared skills as dictionary ids where the dictionary knows them: a skill
 * typed or imported before the dictionary had it ("power bi", "Tableau", "Next.js") counts
 * as the id the JD parser now emits ("power_bi", "tableau", "nextjs"). Unknown skills stay
 * as typed (matched as whole words in the JD — `stackAdjacency`).
 */
export function canonicalStack(skills: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of skills) {
    const id = matchSkillToken(s) ?? s;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Skills that are "the hard part" — having them covers a language gap (§11.1). */
const SYSTEMS_CORE = new Set([
  "distributed_systems",
  "kafka",
  "microservices",
  "grpc",
  "postgres",
  "redis",
  "kubernetes",
  "fintech_domain",
]);

type EdgeMap = Map<string, Map<string, number>>;
const EDGE_MAP: EdgeMap = (() => {
  const m: EdgeMap = new Map();
  for (const e of STACK_EDGES) {
    if (!m.has(e.from)) m.set(e.from, new Map());
    m.get(e.from)!.set(e.to, e.weight);
    // identity
    if (!m.has(e.from)) m.set(e.from, new Map());
  }
  return m;
})();

/** transfer weight from a single owned skill to a single target skill. */
export function transfer(from: string, to: string): number {
  if (from === to) return 1;
  return EDGE_MAP.get(from)?.get(to) ?? 0;
}

export function isLanguage(skill: string): boolean {
  return LANGUAGES.has(skill);
}

export interface StackAdjacencyResult {
  /** [0,1] blended stack fit */
  score: number;
  /** the JD's primary language, if any */
  jdPrimaryLanguage: string | null;
  /** true when the role's main language differs from all of yours but is reachable */
  languageStretch: boolean;
  /** human-readable note for the match card (§11.6) */
  note: string;
}

/** What the posting says beyond its skill list — lets the note name the RIGHT main language. */
export interface StackContext {
  title?: string;
  jdText?: string;
}

/**
 * Mention patterns per language, only to ORDER the languages a JD lists (which one is the
 * role's main one). `jdSkills` comes in dictionary order, so "the first language listed"
 * called a Go/Python streaming role "Primary language java" (2026-11 feed review).
 */
const LANGUAGE_MENTION: Readonly<Record<string, RegExp>> = {
  java: /\bjava\b(?![\s-]?script)|\bspring boot\b|\bjvm\b/gi,
  kotlin: /\bkotlin\b/gi,
  go: /\bgolang\b|\bgo\b(?=\s*(?:programming|developer|engineer|lang|routines?|services|\(|,|\/))|(?<=\b(?:in|with|using|writing)\s)go\b/gi,
  scala: /\bscala\b/gi,
  rust: /\brust\b/gi,
  csharp: /c#|\.net\b|\bdotnet\b/gi,
  python: /\bpython3?\b|\bdjango\b|\bfastapi\b|\bflask\b/gi,
  typescript: /\btypescript\b/gi,
  javascript: /\bjavascript\b|\bnode\.?js\b/gi,
  php: /\bphp\b|\blaravel\b/gi,
  ruby: /\bruby\b|\brails\b/gi,
  cpp: /c\+\+/gi,
  c: /(?<![\w#+.\-/])C(?=\s*\/\s*C\+\+|,\s*C\+\+|\s+programming\b)|\bEmbedded C\b/g,
  swift: /(?<![\w.])Swift(?![\w])|\bSwiftUI\b/g,
  objective_c: /\bobjective-?c\b|\bobj-c\b/gi,
  dart: /\bdart\b|\bflutter\b/gi,
  r: /(?<![\w&/.\-])R(?=\s*(?:[,/]|\s+(?:and|or)\s)\s*(?:Python|SQL|SAS)\b|\s+programming\b)|(?<=\b(?:Python|SQL|SAS)(?:\s*[,/]\s*|\s+(?:and|or)\s+))R(?![\w&])/g,
  sas: /(?<![\w])SAS(?![\w])/g,
};

/** the role's main language: named in the title, else the most-mentioned (then earliest) in the JD */
export function primaryLanguage(jdLangs: readonly string[], ctx: StackContext = {}): string | null {
  if (jdLangs.length <= 1 || (!ctx.title && !ctx.jdText)) return jdLangs[0] ?? null;
  const inTitle = jdLangs.filter((l) => countMentions(l, ctx.title ?? "") > 0);
  if (inTitle.length === 1) return inTitle[0]!;
  const pool = inTitle.length ? inTitle : jdLangs;
  const jd = (ctx.jdText ?? "").slice(0, 8000);
  const ranked = pool
    .map((l, i) => ({ l, i, n: countMentions(l, jd), first: firstMention(l, jd) }))
    .sort((a, b) => b.n - a.n || a.first - b.first || a.i - b.i);
  return ranked[0]?.l ?? null;
}

function countMentions(lang: string, text: string): number {
  const re = LANGUAGE_MENTION[lang];
  if (!re || !text) return 0;
  return text.match(new RegExp(re.source, re.flags))?.length ?? 0;
}
function firstMention(lang: string, text: string): number {
  const re = LANGUAGE_MENTION[lang];
  if (!re) return Infinity;
  const i = text.search(new RegExp(re.source, re.flags.replace("g", "")));
  return i < 0 ? Infinity : i;
}

/** "distributed_systems" → "distributed systems", "ci_cd" → "CI/CD" — card copy, not ids */
export function skillText(skill: string): string {
  // a short free-form skill the user typed ("sql", "r") reads as the acronym it is
  return SKILL_TEXT[skill] ?? LANG_TEXT[skill] ?? (/^[a-z]{1,3}$/.test(skill) ? skill.toUpperCase() : skill.replace(/_/g, " "));
}
const SKILL_TEXT: Readonly<Record<string, string>> = {
  ci_cd: "CI/CD",
  fintech_domain: "fintech",
  distributed_systems: "distributed systems",
  csharp: "C#",
  cpp: "C++",
  ml: "ML",
  aws: "AWS",
  gcp: "GCP",
  grpc: "gRPC",
  rest: "REST APIs",
  kafka: "Kafka",
  rabbitmq: "RabbitMQ",
  postgres: "Postgres",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  elasticsearch: "Elasticsearch",
  cassandra: "Cassandra",
  graphql: "GraphQL",
  docker: "Docker",
  kubernetes: "Kubernetes",
  azure: "Azure",
  terraform: "Terraform",
  spark: "Spark",
  airflow: "Airflow",
  react: "React",
  nextjs: "Next.js",
  vue: "Vue",
  nuxt: "Nuxt",
  angular: "Angular",
  svelte: "Svelte",
  css: "CSS",
  html: "HTML",
  sass: "Sass",
  jest: "Jest",
  cypress: "Cypress",
  playwright: "Playwright",
  webpack: "webpack",
  storybook: "Storybook",
  figma: "Figma",
  swiftui: "SwiftUI",
  sql: "SQL",
  excel: "Excel",
  tableau: "Tableau",
  power_bi: "Power BI",
  looker: "Looker",
  pandas: "pandas",
  numpy: "NumPy",
  dbt: "dbt",
  statistics: "statistics",
  ab_testing: "A/B testing",
};
const LANG_TEXT: Readonly<Record<string, string>> = {
  java: "Java", kotlin: "Kotlin", go: "Go", scala: "Scala", rust: "Rust", csharp: "C#", python: "Python",
  typescript: "TypeScript", javascript: "JavaScript", php: "PHP", ruby: "Ruby", cpp: "C++",
  c: "C", swift: "Swift", objective_c: "Objective-C", dart: "Dart", r: "R", sas: "SAS",
};
const langText = (l: string) => LANG_TEXT[l] ?? l;
const list = (xs: readonly string[], f: (s: string) => string = skillText) => {
  const t = xs.map(f);
  return t.length <= 1 ? (t[0] ?? "") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};

/**
 * Score how transferable the candidate's stack is to a posting's required stack.
 * Domain/systems fit is weighted high; specific-language fit weighted low — so a Go
 * fintech+Kafka role scores ABOVE a Java CRUD role you don't care about (§11.1).
 *
 * `ctx` (title + JD text) decides which listed language is the MAIN one, and lets a
 * declared skill the dictionary doesn't know ("sql", "tableau", "vue") count when the JD
 * names it as a word — otherwise an analyst's or a frontend dev's real overlap is invisible.
 */
export function stackAdjacency(
  ownedSkills: string[],
  jdSkillsIn: string[],
  ctx: StackContext = {},
): StackAdjacencyResult {
  const ownedList = canonicalStack(ownedSkills);
  const owned = new Set(ownedList);
  // declared skills outside the dictionary, found in the JD as whole words (title or text)
  const extra = ctx.jdText || ctx.title ? ownedList.filter((s) => !jdSkillsIn.includes(s) && isFreeSkill(s) && mentions(`${ctx.title ?? ""}\n${(ctx.jdText ?? "").slice(0, 8000)}`, s)) : [];
  const jdSkills = [...jdSkillsIn, ...extra];
  const jdLangs = jdSkills.filter(isLanguage);
  // a domain the JD names counts only when it is yours too (context, never a gap)
  const jdNonLangs = jdSkills.filter((s) => !isLanguage(s) && (!isDomainSkill(s) || owned.has(s)));

  // best transfer from any owned skill to each JD skill
  const bestTransfer = (target: string): number => {
    let best = owned.has(target) ? 1 : 0;
    for (const o of owned) best = Math.max(best, transfer(o, target));
    return best;
  };

  // language component (low weight)
  const langScores = jdLangs.map(bestTransfer);
  const langScore = langScores.length ? avg(langScores) : 1; // no lang req → no penalty

  // domain/systems component (high weight)
  const nonLangScores = jdNonLangs.map(bestTransfer);
  const domainScore = nonLangScores.length ? avg(nonLangScores) : 0.6;

  // systems-core coverage bonus: having the hard parts covers a language gap
  const coreOverlap = [...SYSTEMS_CORE].filter((s) => owned.has(s) && jdSkills.includes(s));
  const coreBonus = Math.min(0.15, coreOverlap.length * 0.05);

  const score = clamp01(0.65 * domainScore + 0.25 * langScore + coreBonus);

  // narrative — plain words, and only what the posting supports
  const jdPrimaryLanguage = primaryLanguage(jdLangs, ctx);
  const haveLang = jdLangs.some((l) => owned.has(l));
  const languageStretch = jdLangs.length > 0 && !haveLang && langScore >= 0.5;
  const have = jdNonLangs.filter((s) => owned.has(s));
  const missing = jdNonLangs.filter((s) => !owned.has(s));
  const tools =
    jdNonLangs.length === 0
      ? ""
      : have.length === 0
        ? ` It also names ${list(missing.slice(0, 4))}${missing.length > 4 ? " …" : ""} — not on your list.`
        : ` You have ${list(have.slice(0, 4))}${have.length > 4 ? ` +${have.length - 4} more` : ""}${missing.length ? `; new to you: ${list(missing.slice(0, 3))}${missing.length > 3 ? " …" : ""}` : ""}.`;

  let note: string;
  if (jdLangs.length === 0) {
    note = jdNonLangs.length
      ? `No specific language asked.${tools}`
      : "The posting names no languages or tools we recognise — judge the fit from the description.";
  } else if (jdPrimaryLanguage && owned.has(jdPrimaryLanguage)) {
    note = `Main language ${langText(jdPrimaryLanguage)} — you have it.${tools}`;
  } else if (haveLang && jdPrimaryLanguage) {
    // you have ANOTHER language the JD lists, not its main one — say exactly that, never
    // "you have it" (honest card: the main language is still new to you)
    const yours = jdLangs.filter((l) => owned.has(l));
    note = `Main language ${langText(jdPrimaryLanguage)} is new to you; it also lists ${list(yours, langText)}, which you have.${tools}`;
  } else if (languageStretch && jdPrimaryLanguage) {
    const from = [...owned].filter((o) => isLanguage(o) && transfer(o, jdPrimaryLanguage) >= 0.5).sort((a, b) => transfer(b, jdPrimaryLanguage) - transfer(a, jdPrimaryLanguage))[0];
    const coreNote = coreOverlap.length ? ` Your ${list(coreOverlap)} experience is the harder part to find.` : "";
    note = `Main language ${langText(jdPrimaryLanguage)} is new to you${from ? ` — close to ${langText(from)}, which you know` : ""}.${coreNote}${tools}`;
  } else {
    note = `Main language ${langText(jdPrimaryLanguage ?? jdLangs[0]!)} is new to you and not close to the languages you list.${tools}`;
  }

  return { score, jdPrimaryLanguage, languageStretch, note: note.replace(/\s+/g, " ").trim() };
}

/** a declared skill the dictionary has no id for: "sql", "tableau", "power bi", "vue" */
function isFreeSkill(skill: string): boolean {
  // a dictionary skill the JD parse didn't find is absent on purpose ("react to incidents")
  return !isLanguage(skill) && matchSkillToken(skill) == null && skill.trim().length >= 1;
}

function mentions(text: string, skill: string): boolean {
  const w = skill.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // whole word; a one/two-letter skill ("r") only as a standalone capital ("R, Python")
  if (skill.trim().length <= 2) return new RegExp(`(^|[^\\p{L}\\p{N}])${w.toUpperCase()}(?=[,/;)]|\\s+(and|or)\\b)`, "u").test(text);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
