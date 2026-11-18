import type { Requirement } from "../schema/entities.js";
import type { RequirementStrength } from "../schema/enums.js";

/**
 * Skill parsing (§ Normalizer, §11.1). A canonical skill vocabulary plus aliases,
 * so "Postgres"/"PostgreSQL"/"psql" all collapse to `postgres`. Backend/platform/
 * fintech-weighted because that's the target shape (§0.2).
 */

// canonical skill → alias regex fragments
const SKILL_ALIASES: Record<string, string[]> = {
  // boundaries matter: a bare "java" alias also matched every "JavaScript" JD
  java: ["\\bjava\\b", "\\bjvm\\b", "spring boot", "\\bspring\\b", "hibernate"],
  kotlin: ["kotlin", "ktor"],
  // "go" is highly ambiguous with the English word — require a language cue so
  // "go-to-market" / "go live" in boilerplate don't false-positive (§ Normalizer).
  go: [
    "golang",
    "go lang",
    "\\bgo\\b(?=\\s*(programming|developer|engineer|lang|routines?|services|\\(|,|/))",
    "(?<=\\b(in|with|using|writing|knowledge of|experience (in|with))\\s)go\\b",
  ],
  scala: ["scala", "akka"],
  rust: ["rust", "tokio"],
  csharp: ["c#", "\\.net", "dotnet", "asp\\.net"],
  python: ["python3?", "django", "flask", "fastapi"],
  typescript: ["typescript", "\\bts\\b"],
  php: ["\\bphp\\b", "laravel", "symfony", "codeigniter"],
  ruby: ["\\bruby\\b", "\\brails\\b", "ruby on rails"],
  cpp: ["c\\+\\+", "\\bcpp\\b"],
  javascript: ["javascript", "node\\.?js", "\\bnode\\b(?=\\s*(\\.js|js|,|/|\\)|backend|developer|engineer|services?|apis?|ecosystem|and (typescript|express|react)))", "\\bjs\\b", "express\\.?js"],
  // "react" is also the verb ("react to incidents") — the library needs a tech cue
  react: ["react\\.?js", "react(?=\\s*(native|hooks|query|router|components?|developer|engineer|frontend|front-end|,|;|/|\\)|\\+|$|and (redux|typescript|next)))", "(?<=\\b(in|with|using|of|knowledge of|experience (in|with))\\s)react", "redux"],
  // frameworks a frontend résumé lists by name (Next.js was folded into React, so a Next.js
  // role told a React developer nothing about the gap — 2026-11 feed review)
  nextjs: ["next\\.?js"],
  vue: ["vue\\.?js", "vuejs", "vuex", "pinia"], // the bare word is CASED ("en vue de" is French)
  nuxt: ["nuxt(\\.?js)?"],
  angular: ["angular(\\.?js)?"],
  svelte: ["svelte(kit)?"],
  css: ["css3?", "tailwind ?css", "tailwindcss"],
  html: ["html5?"],
  sass: ["sass", "scss"],
  jest: ["jest"],
  cypress: ["cypress"],
  playwright: ["playwright"],
  webpack: ["webpack"],
  storybook: ["storybook"],
  figma: ["figma"],
  // mobile languages: an iOS role named "no languages we recognise" (2026-11 feed review).
  // "Swift" the language is CASED (SWIFT is the banking network, "swift" an adjective)
  swiftui: ["swiftui"],
  objective_c: ["objective-c", "objectivec", "obj-c"],
  dart: ["\\bdart\\b", "flutter"],
  // data / analytics: the analyst persona's résumé read as "python" alone
  sql: ["sql", "t-sql", "pl/sql"],
  tableau: ["tableau(?!\\s+de\\b)"], // "tableau de bord" is French for dashboard
  power_bi: ["power ?bi", "powerbi"],
  looker: ["looker( studio)?"],
  pandas: ["pandas"],
  numpy: ["numpy"],
  dbt: ["dbt"],
  // (not Snowflake: it is as often a customer named in company boilerplate as a skill)
  // statistics as a skill or a field of study, never "frequently cited statistics show…"
  statistics: [
    "statistical (analysis|modell?ing|methods|inference|programming|software)",
    "(knowledge|background|experience|expertise|degree|coursework|skills?|proficiency) (in|of) (applied )?statistics",
    "statistics(?=,? (and |or )?(mathematics|maths?|economics|computer science|data science|physics|engineering)\\b)",
    "(?<=\\b(mathematics|maths?|economics|computer science|cs|data science|physics), (or |and )?)statistics",
  ],
  ab_testing: ["a/b test(s|ing)?", "ab testing", "split testing"],
  kafka: ["kafka", "kafka streams", "ksql", "confluent"],
  rabbitmq: ["rabbitmq", "amqp"],
  postgres: ["postgres", "postgresql", "psql"],
  mysql: ["mysql", "mariadb"],
  mongodb: ["mongodb", "mongo"],
  redis: ["redis", "valkey"],
  elasticsearch: ["elasticsearch", "elastic search", "opensearch", "\\belk\\b"],
  cassandra: ["cassandra", "scylla"],
  grpc: ["grpc", "protobuf", "protocol buffers"],
  graphql: ["graphql", "apollo"],
  rest: ["rest api", "restful", "\\brest\\b(?=\\s*(api|service|endpoint))"],
  microservices: ["micro-?services?", "service[- ]oriented", "\\bsoa\\b"],
  // not "consensus": "build consensus with stakeholders" is in half of all JDs
  distributed_systems: ["distributed systems?", "raft consensus", "\\braft\\b(?=\\s*(,|/|\\)|and paxos|protocol|algorithm))", "paxos"],
  docker: ["docker(s|ized|ised|file|files|compose)?", "containers", "containeri[sz](ation|ed)"],
  kubernetes: ["kubernetes", "k8s", "helm", "eks", "gke"],
  aws: ["\\baws\\b", "amazon web services", "ec2", "\\bs3\\b", "lambda", "dynamodb"],
  gcp: ["\\bgcp\\b", "google cloud", "bigquery"],
  azure: ["azure"],
  terraform: ["terraform", "\\biac\\b", "infrastructure as code", "pulumi"],
  ci_cd: ["ci/cd", "continuous integration", "jenkins", "github actions", "gitlab ci"],
  spark: ["apache spark", "\\bspark\\b", "pyspark"],
  airflow: ["airflow", "dagster", "prefect"],
  ml: ["machine learning", "\\bml\\b", "pytorch", "tensorflow", "llms?", "\\brag\\b"],
  // a DOMAIN, not a skill: context on the card ("you have fintech"), never "new to you"
  // (`isDomainSkill`, match/stack.ts)
  fintech_domain: ["payments", "ledger", "double[- ]entry", "wallet", "settlement", "trading", "fintech", "banking", "\\bkyc\\b", "\\bsip\\b"],
};

const MUST_HAVE_CUES = [
  /\b(required|must have|must-have|essential|mandatory|you have|strong experience|proficien)\b/i,
  /\b\d+\+?\s*years?\b/i,
];
const NICE_CUES = [/\b(nice to have|preferred|bonus|plus|a plus|good to have|familiarity)\b/i];

/**
 * Extract the set of canonical skills mentioned anywhere in a JD. Aliases match whole words:
 * as substrings, "scalable" read as Scala, "trust" as Rust, "storage"/"leverage" as RAG (ML)
 * and "weeks" as EKS (Kubernetes) — 90% of the Scala and 97% of the Rust tags on a live
 * corpus were false (audit 2026-11), feeding stack scores and "JD requires X" flags.
 */
export function extractSkills(text: string): string[] {
  if (!text) return [];
  return matchAliases(text);
}

/**
 * Skills whose name is also an English word, recognised by their capitalised proper-noun
 * form — "React and CSS" is the library, "react to incidents" is the verb.
 */
const CASED: ReadonlyArray<readonly [string, RegExp]> = [
  ["react", /(?<![\w])React(?![\w])(?!\s+(?:to|quickly|swiftly|fast|calmly|appropriately|accordingly|positively)\b)/],
  ["vue", /(?<![\w])Vue(?![\w])/],
  // the language, not SWIFT payments or a swift response: "Swift" cased, not before a
  // payments word, not after an adjective slot ("a Swift transition" is rare in JDs)
  ["swift", /(?<![\w.])Swift(?![\w])(?!\s+(?:codes?|payments?|messages?|messaging|network|transfers?|gpi|MT\d*|action|response|delivery)\b)/],
  // Excel the tool — "excel at" / "excel in" is the verb
  ["excel", /(?<![\w])(?:(?:MS|Microsoft)\s+)?Excel(?![\w])(?!\s+(?:at|in)\b)/],
  // R and SAS only beside another analytics language or with a language word: a bare
  // capital R is a trademark, "R&D", a grade; SAS is also an airline, a disk bus and an
  // Azure token
  ["r", new RegExp(String.raw`(?<![\w&/.\-])R(?![\w&'’+\-)])(?=\s*(?:[,/]\s*|\s+(?:and|or)\s+)(?:Python|SQL|SAS|Stata|MATLAB|Julia|Scala)\b|\s+(?:programming|language|Studio|Shiny|Markdown)\b)|(?<=\b(?:Python|SQL|SAS|Stata|MATLAB|Julia)(?:\s*[,/]\s*|\s+(?:and|or)\s+))R(?![\w&'’+\-)])`)],
  ["sas", new RegExp(String.raw`(?<![\w])SAS(?![\w])(?=\s*(?:[,/]\s*|\s+(?:and|or)\s+)(?:Python|SQL|R|Stata|SPSS|MATLAB)\b|\s+(?:programming|Enterprise|Viya|Base|EG|macros?)\b)|(?<=\b(?:Python|SQL|R|Stata|SPSS|MATLAB)(?:\s*[,/]\s*|\s+(?:and|or)\s+))SAS(?![\w])`)],
  // C only where it is plainly the language: "C/C++", "C, C++", "Embedded C", "C programming"
  ["c", new RegExp(String.raw`(?<![\w#+.\-/])C(?![\w#+\-])(?=\s*(?:\/\s*C\+\+|,\s*C\+\+|\s+(?:and|or)\s+C\+\+|\s+(?:programming|language)\b))|(?<=\b(?:Embedded|ANSI|Linux|in)\s)C(?![\w#+\-])(?=\s*(?:[,/;.)]|\s+(?:and|or)\b|$))`)],
];

function matchAliases(text: string): string[] {
  const found = TOKEN_COMPILED.filter(([, re]) => re.test(text)).map(([skill]) => skill);
  for (const [skill, re] of CASED) if (!found.includes(skill) && re.test(text)) found.push(skill);
  return found;
}

/**
 * Parse requirements with strength by looking at the sentence each skill appears in.
 * "Go required" → must_have (becomes a stretch flag, not an exclusion, §11.1).
 */
export function parseRequirements(text: string): Requirement[] {
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?\n])\s+|•|•|·|\n-|\n\*/);
  const byskill = new Map<string, RequirementStrength>();

  for (const sentence of sentences) {
    const skills = extractSkills(sentence);
    if (skills.length === 0) continue;
    const strength: RequirementStrength = NICE_CUES.some((re) => re.test(sentence))
      ? "nice_to_have"
      : MUST_HAVE_CUES.some((re) => re.test(sentence))
        ? "must_have"
        : "transferable";
    for (const s of skills) {
      const prev = byskill.get(s);
      // upgrade priority: must_have > nice_to_have > transferable; but a must wins
      if (!prev || rank(strength) > rank(prev)) byskill.set(s, strength);
    }
  }
  return [...byskill.entries()].map(([skill, strength]) => ({ skill, strength }));
}

function rank(s: RequirementStrength): number {
  return s === "must_have" ? 2 : s === "nice_to_have" ? 1 : 0;
}

// ── token-level matching (résumé skills sections — onboarding, §4) ──

/** Every canonical skill id the alias dictionary knows. */
export const CANONICAL_SKILLS: readonly string[] = Object.keys(SKILL_ALIASES);

/**
 * Display forms the prose-oriented aliases deliberately don't match on their own ("Go"
 * needs a language cue inside a JD sentence; alone in a skills list it IS the language).
 * Keys are lower-cased whole tokens.
 */
const EXACT_SKILL_TOKENS: Record<string, string> = {
  go: "go",
  // CASED in prose; alone in a skills list they ARE the skill
  r: "r",
  sas: "sas",
  c: "c",
  swift: "swift",
  excel: "excel",
  "ms excel": "excel",
  "microsoft excel": "excel",
  vue: "vue",
  "power bi": "power_bi",
  "a/b testing": "ab_testing",
  statistics: "statistics",
  "nodejs": "javascript",
  "node.js": "javascript",
  node: "javascript",
  "c#": "csharp",
  "c++": "cpp",
  rest: "rest",
  "rest api": "rest",
  "rest apis": "rest",
  "restful apis": "rest",
  "ci/cd": "ci_cd",
  cicd: "ci_cd",
  ml: "ml",
};

/**
 * Same aliases, but whole-word on both sides: a skills-list token must BE the skill, so
 * "Reactive" isn't React and "Trust & Safety" isn't Rust. `java` stays bounded, so
 * "JavaScript" canonicalizes to javascript, never java.
 */
const TOKEN_COMPILED: Array<[string, RegExp]> = Object.entries(SKILL_ALIASES).map(
  ([skill, aliases]) => [skill, new RegExp(`(?<![\\w])(${aliases.join("|")})(?![\\w])`, "i")],
);

/**
 * Whole-word skill extraction for a candidate's own prose. Since the JD extractor went
 * whole-word too (it misfired the same way: "storage" ⊃ "rag", "weeks" ⊃ "eks") this is
 * the same matcher; kept as its own name for its callers.
 */
export function extractSkillsStrict(text: string): string[] {
  if (!text) return [];
  return matchAliases(text);
}

/**
 * Canonicalize ONE token from a skills list ("PostgreSQL" → "postgres", "Go" → "go").
 * Null when the dictionary doesn't know it — callers keep those as `unrecognized`
 * instead of guessing. Long phrases (> 4 words) never canonicalize: a sentence that
 * merely mentions a skill isn't a skills-list entry.
 */
export function matchSkillToken(token: string): string | null {
  const t = token.trim().replace(/\s+/g, " ").replace(/[.:;,]+$/, "");
  if (!t || t.length > 40 || t.split(" ").length > 4) return null;
  const lower = t.toLowerCase();
  const exact = EXACT_SKILL_TOKENS[lower];
  if (exact) return exact;
  if (Object.prototype.hasOwnProperty.call(SKILL_ALIASES, lower)) return lower;
  // the alias covering the most of the token wins: "Next.js" is Next.js, though "js" alone
  // is a JavaScript alias (dictionary order read every "*.js" framework as JavaScript)
  let best: { skill: string; len: number } | null = null;
  for (const [skill, re] of TOKEN_COMPILED) {
    const m = re.exec(t);
    if (m && (!best || m[0].length > best.len)) best = { skill, len: m[0].length };
  }
  return best?.skill ?? null;
}
