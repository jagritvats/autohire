import { randomUUID } from "node:crypto";
import type { Evidence, Profile } from "@jobflow/core";
import type { SeedCompany } from "./discover.js";

export const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Seed registry (§12 open Q3). Mix of:
 *  - confirmed-live ATS boards (guarantee a non-empty demo), and
 *  - names-only for fintech/YC targets the ATS Detector resolves at discover-time.
 * Shape matches §0.2: fintech startups + Indian product cos + international remote.
 */
export const SEED_COMPANIES: SeedCompany[] = [
  { name: "Stripe", careersUrl: "https://boards.greenhouse.io/stripe", tags: ["fintech", "target"], pollCadence: "daily" },
  { name: "Ramp", careersUrl: "https://jobs.ashbyhq.com/ramp", tags: ["fintech", "target"], pollCadence: "daily" },
  { name: "Deel", careersUrl: "https://jobs.ashbyhq.com/Deel", tags: ["fintech", "remote"], pollCadence: "daily" },
  { name: "Linear", careersUrl: "https://jobs.ashbyhq.com/Linear", tags: ["product", "remote"] },
  { name: "Plaid", careersUrl: "https://boards.greenhouse.io/plaid", tags: ["fintech"] },
  { name: "Match Group", careersUrl: "https://jobs.lever.co/matchgroup", tags: ["product"] },
  { name: "Palantir", careersUrl: "https://jobs.lever.co/palantir", tags: ["platform"] },

  { name: "Razorpay", tags: ["fintech", "india", "target"], pollCadence: "daily" },
  { name: "Zerodha", tags: ["fintech", "india", "target"], pollCadence: "daily" },
  { name: "Groww", tags: ["fintech", "india", "target"] },
  { name: "CRED", tags: ["fintech", "india", "target"] },
  { name: "PhonePe", tags: ["fintech", "india"] },
  { name: "Setu", tags: ["fintech", "india"] },
  { name: "Juspay", tags: ["fintech", "india"] },

  { name: "Vercel", careersUrl: "https://boards.greenhouse.io/vercel", tags: ["product", "remote"] },
  { name: "Supabase", tags: ["product", "remote", "oss"] },
];

/** Single-tenant default profile — encodes §0.2 + §11. */
export function defaultProfile(): Profile {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    tenantId: DEFAULT_TENANT,
    masterResume:
      "Backend engineer, ~2 YoE. Java/Spring + TypeScript/Node. Distributed systems, " +
      "Kafka (kafka-ui OSS contributor), Postgres, Redis, event-driven architecture, " +
      "idempotent ledgers, double-entry accounting, production LLM infra. Built NexusAlgo " +
      "(production LLM trading infra with live P&L), Verdict (full-stack ship-fast), Synapse, " +
      "and contributed to kafka-ui. Strong on systems design, concurrency, and fintech domain.",
    profileEmbedding: null,
    yoe: 2,
    levelBand: "mid",
    prefs: {
      salaryFloor: 2_000_000,
      currency: "INR",
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
        "distributed_systems", "microservices", "rest", "docker", "fintech_domain", "ml",
      ],
      remoteGeoOk: ["india_ok", "worldwide", "apac_ok"],
      relocate: true,
      targetArchetypes: ["backend", "platform", "infra_devops"],
    },
  };
}

/** Evidence Bank seed (§4, §5) — the anti-hallucination spine. */
export function seedEvidence(): Evidence[] {
  const t = DEFAULT_TENANT;
  const mk = (
    project: string,
    headline: string,
    detail: string,
    metric: string | null,
    tags: string[],
  ): Evidence => ({ id: randomUUID(), tenantId: t, project, headline, detail, metric, tags, embedding: null });
  return [
    mk("NexusAlgo", "Production LLM trading infrastructure with live P&L",
      "Built an event-driven pipeline orchestrating LLM inference for trading signals; handled " +
      "backpressure, idempotent state, and an ensemble scoring model under live capital.",
      "live P&L; ensemble of N models",
      ["llm", "ml", "distributed_systems", "fintech_domain", "backpressure", "production"]),
    mk("kafka-ui", "Open-source contribution to kafka-ui",
      "Contributed to the kafka-ui OSS project — real Kafka internals (consumer groups, offsets, " +
      "partitions), not just 'used Kafka in a side project'.",
      "merged OSS PRs", ["kafka", "oss", "distributed_systems", "java"]),
    mk("Verdict", "Full-stack product, shipped fast",
      "End-to-end TypeScript app (Next + Postgres) — demonstrates ship-fast full-stack and product sense.",
      null, ["typescript", "fullstack", "postgres", "rest", "product"]),
    mk("ZFH ledger/wallet", "Idempotent wallet/ledger with double-entry semantics",
      "Designed a wallet + ledger with idempotency keys, double-entry accounting, a SIP engine, and " +
      "offset-correct Mongo pagination — the fintech systems core.",
      "idempotent; double-entry",
      ["fintech_domain", "ledger", "idempotency", "distributed_systems", "java"]),
    mk("Synapse", "Systems project",
      "Backend systems work reinforcing distributed-systems and data-modelling depth.",
      null, ["distributed_systems", "backend"]),
  ];
}
