import type { Requirement } from "../schema/entities.js";
import type { RequirementStrength } from "../schema/enums.js";

/**
 * Skill parsing (§ Normalizer, §11.1). A canonical skill vocabulary plus aliases,
 * so "Postgres"/"PostgreSQL"/"psql" all collapse to `postgres`. Backend/platform/
 * fintech-weighted because that's the target shape (§0.2).
 */

// canonical skill → alias regex fragments
const SKILL_ALIASES: Record<string, string[]> = {
  java: ["java", "jvm", "spring boot", "spring", "hibernate"],
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
