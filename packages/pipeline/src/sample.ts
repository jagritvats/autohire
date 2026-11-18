import { randomUUID } from "node:crypto";
import type { Evidence, Profile } from "@jobflow/core";
import { DEFAULT_TENANT } from "./seed.js";

/**
 * A FICTIONAL sample candidate — "Alex Example". Used only by `jobflow demo`, tests,
 * screenshots and an explicit "load sample profile" action; real users start from
 * `blankProfile()` and onboard with their own résumé. Every name, project and metric
 * below is invented, so nothing here can leak into a real user's drafts.
 */
export const SAMPLE_RESUME = [
  "Alex Example",
  "alex@example.com · github.com/alex-example · Bengaluru, India",
  "",
  "SUMMARY",
  "Backend engineer with 3 years of experience building event-driven services in Java and TypeScript.",
  "",
  "EXPERIENCE",
  "Software Engineer, Acme Payments — Jan 2023 – Present",
  "- Built an idempotent double-entry ledger service in Java/Spring handling 2M transactions/day",
  "- Moved settlement jobs onto Kafka consumers with exactly-once processing, cutting reconciliation time by 40%",
  "Associate Engineer, Globex Retail — Jul 2021 – Dec 2022",
  "- Shipped a Node/TypeScript order API on Postgres and Redis serving 300 req/s",
  "",
  "PROJECTS",
  "Queue Lens — open-source Kafka consumer-lag dashboard (TypeScript, React)",
  "Shipfast — Next.js + Postgres side project with 1k monthly users",
  "",
  "SKILLS",
  "Java, Spring, TypeScript, Node.js, Kafka, PostgreSQL, Redis, Docker, Kubernetes, REST, microservices",
].join("\n");

export function sampleProfile(tenantId: string = DEFAULT_TENANT): Profile {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    tenantId,
    masterResume: SAMPLE_RESUME,
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 3,
    levelBand: "mid",
    onboardedAt: "2026-01-01T00:00:00.000Z",
    resumeFile: null,
    prefs: {
      salaryFloor: 2_000_000,
      currency: "INR",
      display: { currency: "auto", period: "year" },
      homeCountry: "IN",
      markets: ["IN"],
      contact: {
        firstName: "Alex",
        lastName: "Example",
        email: "alex@example.com",
        phone: "",
        linkedin: "linkedin.com/in/alex-example",
        github: "github.com/alex-example",
        portfolio: "",
        resumePath: "",
      },
      locationWeights: [
        { label: "remote", weight: 1.0 },
        { label: "bengaluru", weight: 0.85 },
        { label: "bangalore", weight: 0.85 },
        { label: "pune", weight: 0.85 },
        { label: "mumbai", weight: 0.8 },
        { label: "india", weight: 0.7 },
        { label: "remote worldwide", weight: 0.95 },
      ],
      stackMustHaves: [],
      stackProfile: [
        "java", "typescript", "javascript", "kafka", "postgres", "redis",
        "distributed_systems", "microservices", "rest", "docker",
      ],
      remoteGeoOk: ["india_ok", "worldwide", "apac_ok"],
      relocate: true,
      targetArchetypes: ["backend", "platform", "infra_devops"],
    },
  };
}

/** Evidence Bank for the fictional sample — every entry is grounded in SAMPLE_RESUME. */
export function sampleEvidence(tenantId: string = DEFAULT_TENANT): Evidence[] {
  const mk = (
    project: string,
    headline: string,
    detail: string,
    metric: string | null,
    tags: string[],
  ): Evidence => ({ id: randomUUID(), tenantId, project, headline, detail, metric, tags, embedding: null, origin: "sample" });
  return [
    mk("Acme Payments ledger", "Idempotent double-entry ledger service",
      "Built an idempotent double-entry ledger service in Java/Spring handling 2M transactions/day.",
      "2M transactions/day", ["java", "fintech_domain", "idempotency", "distributed_systems"]),
    mk("Acme Payments settlement", "Kafka settlement consumers",
      "Moved settlement jobs onto Kafka consumers with exactly-once processing, cutting reconciliation time by 40%.",
      "-40% reconciliation time", ["kafka", "distributed_systems", "java"]),
    mk("Globex order API", "Order API on Node/TypeScript",
      "Shipped a Node/TypeScript order API on Postgres and Redis serving 300 req/s.",
      "300 req/s", ["typescript", "postgres", "redis", "rest"]),
    mk("Queue Lens", "Open-source Kafka consumer-lag dashboard",
      "Open-source Kafka consumer-lag dashboard written in TypeScript and React.",
      null, ["kafka", "typescript", "oss"]),
  ];
}

/** true when an Evidence Bank entry came from the built-in sample (UI warns before drafting). */
export function isSampleEvidence(e: Pick<Evidence, "origin">): boolean {
  return e.origin === "sample";
}
