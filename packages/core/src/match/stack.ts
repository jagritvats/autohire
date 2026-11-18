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
]);

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

/**
 * Score how transferable the candidate's stack is to a posting's required stack.
 * Domain/systems fit is weighted high; specific-language fit weighted low — so a Go
 * fintech+Kafka role scores ABOVE a Java CRUD role you don't care about (§11.1).
 */
export function stackAdjacency(
  ownedSkills: string[],
  jdSkills: string[],
): StackAdjacencyResult {
  const owned = new Set(ownedSkills);
  const jdLangs = jdSkills.filter(isLanguage);
  const jdNonLangs = jdSkills.filter((s) => !isLanguage(s));

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

  // narrative
  const jdPrimaryLanguage = jdLangs[0] ?? null;
  const haveLang = jdLangs.some((l) => owned.has(l));
  const languageStretch = jdLangs.length > 0 && !haveLang && langScore >= 0.5;

  let note: string;
  if (jdLangs.length === 0) {
    note = "No hard language requirement; systems/domain fit is what matters.";
  } else if (jdPrimaryLanguage && owned.has(jdPrimaryLanguage)) {
    note = `Primary language ${jdPrimaryLanguage} — direct match.`;
  } else if (haveLang && jdPrimaryLanguage) {
    // you have ANOTHER language the JD lists, not its primary one — say exactly that, never
    // "direct match" (honest card: the main language is still new to you)
    const yours = jdLangs.filter((l) => owned.has(l));
    const t = bestTransfer(jdPrimaryLanguage);
    const ramp = t >= 0.7 ? "~1-2wk ramp" : t >= 0.5 ? "~3-4wk ramp" : "a real ramp";
    note = `Primary language ${jdPrimaryLanguage} is new to you (${ramp}); the role also lists ${yours.join(", ")}, which you have.`;
  } else if (languageStretch) {
    const ramp = langScore >= 0.7 ? "~1-2wk ramp" : "~3-4wk ramp";
    const coreNote = coreOverlap.length
      ? `; your ${coreOverlap.join(" + ")} depth covers the hard part`
      : "";
    note = `Primary language ${jdPrimaryLanguage} (transferable, ${ramp})${coreNote}.`;
  } else {
    note = `Primary language ${jdPrimaryLanguage} is a real stretch from your stack.`;
  }

  return { score, jdPrimaryLanguage, languageStretch, note };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
