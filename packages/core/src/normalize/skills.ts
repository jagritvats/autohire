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
  python: ["python", "django", "flask", "fastapi"],
  typescript: ["typescript", "\\bts\\b"],
  php: ["\\bphp\\b", "laravel", "symfony", "codeigniter"],
  ruby: ["\\bruby\\b", "\\brails\\b", "ruby on rails"],
  cpp: ["c\\+\\+", "\\bcpp\\b"],
  javascript: ["javascript", "node\\.?js", "\\bnode\\b", "\\bjs\\b"],
  react: ["react", "next\\.?js", "redux"],
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
  microservices: ["microservices", "micro-services", "service oriented", "\\bsoa\\b"],
  distributed_systems: ["distributed systems", "distributed system", "consensus", "raft", "paxos"],
  docker: ["docker", "containers", "containerization"],
  kubernetes: ["kubernetes", "k8s", "helm", "eks", "gke"],
  aws: ["\\baws\\b", "amazon web services", "ec2", "\\bs3\\b", "lambda", "dynamodb"],
  gcp: ["\\bgcp\\b", "google cloud", "bigquery"],
  azure: ["azure"],
  terraform: ["terraform", "\\biac\\b", "infrastructure as code", "pulumi"],
  ci_cd: ["ci/cd", "continuous integration", "jenkins", "github actions", "gitlab ci"],
  spark: ["apache spark", "\\bspark\\b", "pyspark"],
  airflow: ["airflow", "dagster", "prefect"],
  ml: ["machine learning", "\\bml\\b", "pytorch", "tensorflow", "llm", "rag"],
  fintech_domain: ["payments", "ledger", "double[- ]entry", "wallet", "settlement", "trading", "fintech", "banking", "\\bkyc\\b", "\\bsip\\b"],
};

const MUST_HAVE_CUES = [
  /\b(required|must have|must-have|essential|mandatory|you have|strong experience|proficien)\b/i,
  /\b\d+\+?\s*years?\b/i,
];
const NICE_CUES = [/\b(nice to have|preferred|bonus|plus|a plus|good to have|familiarity)\b/i];

const COMPILED: Array<[string, RegExp]> = Object.entries(SKILL_ALIASES).map(
  ([skill, aliases]) => [skill, new RegExp(`(${aliases.join("|")})`, "i")],
);

/** Extract the set of canonical skills mentioned anywhere in a JD. */
export function extractSkills(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [skill, re] of COMPILED) {
    if (re.test(text)) found.add(skill);
  }
  return [...found];
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
 * `extractSkills` with whole-word aliases on both sides — for a candidate's own prose,
 * where the JD extractor's substring aliases misfire ("storage" ⊃ "rag", "weeks" ⊃ "eks").
 */
export function extractSkillsStrict(text: string): string[] {
  if (!text) return [];
  return TOKEN_COMPILED.filter(([, re]) => re.test(text)).map(([skill]) => skill);
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
  for (const [skill, re] of TOKEN_COMPILED) if (re.test(t)) return skill;
  return null;
}
