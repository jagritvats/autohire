import { randomUUID } from "node:crypto";
import type { Evidence, Profile } from "@jobflow/core";
import { normCompany } from "@jobflow/core";
import type { SeedCompany } from "./discover.js";
import { INDIA_EMPLOYER_BOARDS, INDIA_SERVICES_BOARDS } from "./seeds-employers.js";
import { LOCAL_BOARD_SEEDS } from "./seeds-local.js";

export const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

/**
 * Seed registry (§12 open Q3) — configuration as data. Every board below was
 * confirmed live (2026-09-27) with India postings, unless noted. Names-only entries are
 * resolved by the ATS Detector (URL → careers-page sniff → slug probe) at discover.
 *
 * Why explicit URLs: Indian companies' board slugs rarely match their names
 * (PhonePe → SmartRecruiters "PHONEPELIMITED", Razorpay → "razorpaysoftwareprivatelimited",
 * Fi → Lever "epifi"), and name-guessing finds unrelated companies (Greenhouse "porter"
 * is a café). Many Indian startups use ATSes with no public API at all (Darwinbox,
 * Keka, Kula, TurboHire) — those reach the feed through the India boards instead.
 */

/** International product/fintech targets — remote-worldwide or India-office roles. */
const GLOBAL_TARGETS: SeedCompany[] = [
  { name: "Stripe", careersUrl: "https://boards.greenhouse.io/stripe", tags: ["fintech", "target", "global"], pollCadence: "daily" },
  { name: "Ramp", careersUrl: "https://jobs.ashbyhq.com/ramp", tags: ["fintech", "target"] },
  { name: "Linear", careersUrl: "https://jobs.ashbyhq.com/Linear", tags: ["product", "remote"] },
  { name: "Plaid", careersUrl: "https://jobs.ashbyhq.com/plaid", tags: ["fintech"] }, // moved off Greenhouse (404) to Ashby
  { name: "Match Group", careersUrl: "https://jobs.lever.co/matchgroup", tags: ["product"] },
  { name: "Palantir", careersUrl: "https://jobs.lever.co/palantir", tags: ["platform"] },
  { name: "Vercel", careersUrl: "https://boards.greenhouse.io/vercel", tags: ["product", "remote"] },
  { name: "Supabase", careersUrl: "https://jobs.ashbyhq.com/supabase", tags: ["product", "remote", "oss"] },
  { name: "Notion", careersUrl: "https://jobs.ashbyhq.com/notion", tags: ["global", "saas"] },
];

/** Indian product / fintech / SaaS companies on a pollable ATS (India eng roles live). */
const INDIA_TARGETS: SeedCompany[] = [
  { name: "Tekion", careersUrl: "https://jobs.ashbyhq.com/tekion", tags: ["india", "saas"], pollCadence: "daily" },
  { name: "Sarvam AI", careersUrl: "https://jobs.ashbyhq.com/sarvam", tags: ["india", "ai"], pollCadence: "daily" },
  { name: "PhonePe", careersUrl: "https://careers.smartrecruiters.com/PHONEPELIMITED", tags: ["india", "fintech", "target"], pollCadence: "daily" },
  { name: "Hevo Data", careersUrl: "https://jobs.lever.co/hevodata", tags: ["india", "saas", "infra"], pollCadence: "daily" },
  { name: "Freshworks", careersUrl: "https://careers.smartrecruiters.com/Freshworks", tags: ["india", "saas"] },
  { name: "HighRadius", careersUrl: "https://boards.greenhouse.io/highradius", tags: ["india", "saas", "fintech"], pollCadence: "daily" },
  { name: "InMobi", careersUrl: "https://boards.greenhouse.io/inmobi", tags: ["india", "saas"] },
  { name: "Meesho", careersUrl: "https://jobs.lever.co/meesho", tags: ["india", "consumer"] },
  { name: "Druva", careersUrl: "https://boards.greenhouse.io/druva", tags: ["india", "saas", "infra"] },
  { name: "Mindtickle", careersUrl: "https://jobs.lever.co/mindtickle", tags: ["india", "saas"] },
  { name: "Glance", careersUrl: "https://boards.greenhouse.io/glance", tags: ["india", "consumer"] },
  { name: "Zeta", careersUrl: "https://jobs.lever.co/zeta", tags: ["india", "fintech"], pollCadence: "daily" },
  { name: "Fampay", careersUrl: "https://jobs.lever.co/fampay", tags: ["india", "fintech"] },
  { name: "Observe.AI", careersUrl: "https://boards.greenhouse.io/observeai", tags: ["india", "ai", "saas"] },
  { name: "Fi Money", careersUrl: "https://jobs.lever.co/epifi", tags: ["india", "fintech"] },
  { name: "ixigo", careersUrl: "https://careers.smartrecruiters.com/ixigo", tags: ["india", "consumer"] },
  { name: "Atlan", careersUrl: "https://jobs.ashbyhq.com/atlan", tags: ["india", "saas", "infra"] },
  { name: "Paytm", careersUrl: "https://jobs.lever.co/paytm", tags: ["india", "fintech"] },
  { name: "Swiggy", careersUrl: "https://careers.smartrecruiters.com/swiggy", tags: ["india", "consumer"] },
  { name: "Razorpay", careersUrl: "https://boards.greenhouse.io/razorpaysoftwareprivatelimited", tags: ["india", "fintech", "target"], pollCadence: "daily" },
  { name: "Zenoti", careersUrl: "https://boards.greenhouse.io/zenoti", tags: ["india", "saas"] },
  { name: "SpotDraft", careersUrl: "https://jobs.ashbyhq.com/spotdraft", tags: ["india", "saas", "ai"] },
  { name: "CRED", careersUrl: "https://jobs.lever.co/cred", tags: ["india", "fintech", "target"] },
  { name: "Groww", careersUrl: "https://boards.greenhouse.io/groww", tags: ["india", "fintech", "target"] },
  // India-market ATSes (Kula / Keka / Zoho Recruit / Freshteam) — verified live 2026-09
  { name: "Cashfree Payments", careersUrl: "https://careers.kula.ai/cashfree", tags: ["india", "fintech"], pollCadence: "daily" },
  { name: "Slice", careersUrl: "https://careers.kula.ai/slice", tags: ["india", "fintech"], pollCadence: "daily" },
  { name: "Acko", careersUrl: "https://careers.kula.ai/acko", tags: ["india", "fintech"] },
  { name: "Rocketlane", careersUrl: "https://careers.kula.ai/rocketlane", tags: ["india", "saas"] },
  { name: "Signzy", careersUrl: "https://signzy.keka.com/careers", tags: ["india", "fintech"] },
  { name: "Eloelo", careersUrl: "https://eloelo.keka.com/careers", tags: ["india", "consumer"] },
  { name: "Jupiter", careersUrl: "https://jupiter.keka.com/careers", tags: ["india", "fintech"] },
  { name: "ClickPost", careersUrl: "https://clickpost.keka.com/careers", tags: ["india", "saas"] },
  { name: "Zluri", careersUrl: "https://zluri.keka.com/careers", tags: ["india", "saas"] },
  { name: "Wissen Technology", careersUrl: "https://wissen.zohorecruit.in/jobs/Careers", tags: ["india", "services"] },
  { name: "Everstage", careersUrl: "https://everstage.freshteam.com", tags: ["india", "saas"] },
  { name: "Locus", careersUrl: "https://locus.freshteam.com", tags: ["india", "saas"] },
  // no pollable ATS found (own portal / Darwinbox / TurboHire…) — kept so the
  // detector can pick them up if they move, and so discovered roles attach to them
  { name: "Zerodha", tags: ["india", "fintech", "target"] },
  { name: "Setu", tags: ["india", "fintech"] },
  { name: "Juspay", tags: ["india", "fintech"] },
];

/** Global companies with India engineering centres, on Greenhouse/Ashby/SmartRecruiters. */
const INDIA_OFFICE_BOARDS: SeedCompany[] = [
  { name: "MongoDB", careersUrl: "https://boards.greenhouse.io/mongodb", tags: ["global", "india", "infra"], pollCadence: "daily" },
  { name: "Okta", careersUrl: "https://boards.greenhouse.io/okta", tags: ["global", "india", "saas"] },
  { name: "Databricks", careersUrl: "https://boards.greenhouse.io/databricks", tags: ["global", "india", "infra"] },
  { name: "Zscaler", careersUrl: "https://boards.greenhouse.io/zscaler", tags: ["global", "india", "infra"] },
  { name: "ServiceNow", careersUrl: "https://careers.smartrecruiters.com/ServiceNow", tags: ["global", "india", "saas"] },
  { name: "Harness", careersUrl: "https://boards.greenhouse.io/harnessinc", tags: ["global", "india", "devtools"] },
  { name: "Glean", careersUrl: "https://boards.greenhouse.io/gleanwork", tags: ["global", "india", "ai"], pollCadence: "daily" },
  { name: "Rubrik", careersUrl: "https://boards.greenhouse.io/rubrik", tags: ["global", "india", "infra"] },
  { name: "Snowflake", careersUrl: "https://jobs.ashbyhq.com/snowflake", tags: ["global", "india", "infra"] },
  { name: "Toast", careersUrl: "https://boards.greenhouse.io/toast", tags: ["global", "india", "saas"] },
  { name: "Tower Research", careersUrl: "https://boards.greenhouse.io/towerresearchcapital", tags: ["global", "india", "fintech"] },
  { name: "Twilio", careersUrl: "https://boards.greenhouse.io/twilio", tags: ["global", "india", "devtools"] },
  { name: "New Relic", careersUrl: "https://boards.greenhouse.io/newrelic", tags: ["global", "india", "infra"] },
  { name: "Coinbase", careersUrl: "https://boards.greenhouse.io/coinbase", tags: ["global", "india", "fintech"] },
  { name: "Wise", careersUrl: "https://careers.smartrecruiters.com/wise", tags: ["global", "india", "fintech"] },
  { name: "Agoda", careersUrl: "https://boards.greenhouse.io/agoda", tags: ["global", "india", "consumer"] },
  { name: "Airbnb", careersUrl: "https://boards.greenhouse.io/airbnb", tags: ["global", "india", "consumer"] },
  { name: "Sumo Logic", careersUrl: "https://boards.greenhouse.io/sumologic", tags: ["global", "india", "infra"] },
];

/**
 * Large employers whose careers backends are Workday / Eightfold / Amazon, polled
 * India-only server-side (JOBFLOW_POLL_COUNTRY). This is where most India SDE-1/SDE-2
 * volume lives. Workday tenants verified live against the CXS jobs endpoint.
 */
const INDIA_BIG_EMPLOYERS: SeedCompany[] = [
  { name: "Amazon", careersUrl: "https://www.amazon.jobs/en/", tags: ["global", "india", "bigtech"], pollCadence: "daily" },
  { name: "Microsoft", careersUrl: "https://apply.careers.microsoft.com/careers?domain=microsoft.com", tags: ["global", "india", "bigtech"], pollCadence: "daily" },
  { name: "Qualcomm", careersUrl: "https://careers.qualcomm.com/careers?domain=qualcomm.com", tags: ["global", "india"] },
  { name: "Nvidia", careersUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite", tags: ["global", "india", "bigtech"] },
  { name: "Salesforce", careersUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site", tags: ["global", "india", "saas"] },
  { name: "Adobe", careersUrl: "https://adobe.wd5.myworkdayjobs.com/external_experienced", tags: ["global", "india"] },
  { name: "PayPal", careersUrl: "https://paypal.wd1.myworkdayjobs.com/jobs", tags: ["global", "india", "fintech"] },
  { name: "Target", careersUrl: "https://target.wd5.myworkdayjobs.com/targetcareers", tags: ["global", "india"] },
  { name: "Cisco", careersUrl: "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers", tags: ["global", "india"] },
  { name: "Mastercard", careersUrl: "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers", tags: ["global", "india", "fintech"] },
  { name: "Visa", careersUrl: "https://visa.wd5.myworkdayjobs.com/Visa", tags: ["global", "india", "fintech"] },
  { name: "Workday", careersUrl: "https://workday.wd5.myworkdayjobs.com/Workday", tags: ["global", "india", "saas"] },
  { name: "Postman", careersUrl: "https://postman.wd108.myworkdayjobs.com/careers", tags: ["india", "devtools"], pollCadence: "daily" },
  { name: "BrowserStack", careersUrl: "https://browserstack.wd3.myworkdayjobs.com/External", tags: ["india", "devtools"], pollCadence: "daily" },
  { name: "Sprinklr", careersUrl: "https://sprinklr.wd1.myworkdayjobs.com/careers", tags: ["india", "saas"] },
  { name: "Uniphore", careersUrl: "https://uniphore.wd503.myworkdayjobs.com/Uniphore", tags: ["india", "ai"] },
  { name: "Expedia", careersUrl: "https://expedia.wd108.myworkdayjobs.com/search", tags: ["global", "india", "consumer"] },
  // Oracle HCM (CX_ site number, never an alias — an unknown site returns every job)
  { name: "JPMorgan Chase", careersUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001", tags: ["global", "india", "fintech"], pollCadence: "daily" },
  { name: "Goldman Sachs", careersUrl: "https://hdpc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3002", tags: ["global", "india", "fintech"] },
  { name: "Icertis", careersUrl: "https://iaaviz.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1", tags: ["india", "saas"] },
  // custom / other ATSes
  { name: "Atlassian", careersUrl: "https://www.atlassian.com/company/careers", tags: ["global", "india", "devtools"] },
  { name: "Nutanix", careersUrl: "https://jobs.jobvite.com/nutanix", tags: ["global", "india", "infra"] },
  { name: "Rippling", careersUrl: "https://ats.rippling.com/rippling/jobs", tags: ["global", "india", "saas"] },
  { name: "Copado", careersUrl: "https://ats.rippling.com/copado/jobs", tags: ["global", "india", "devtools"] },
  { name: "RSA Security", careersUrl: "https://ats.rippling.com/rsa-security/jobs", tags: ["global", "india", "infra"] },
  { name: "Pythian", careersUrl: "https://ats.rippling.com/pythian/jobs", tags: ["global", "india", "infra"] },
  { name: "Forbes Advisor", careersUrl: "https://ats.rippling.com/forbes-advisor/jobs", tags: ["global", "india", "consumer"] },
];

export const SEED_COMPANIES: SeedCompany[] = dedupeSeeds([
  ...INDIA_TARGETS,
  ...INDIA_OFFICE_BOARDS,
  ...INDIA_BIG_EMPLOYERS,
  ...INDIA_EMPLOYER_BOARDS,
  ...INDIA_SERVICES_BOARDS,
  ...GLOBAL_TARGETS,
  ...LOCAL_BOARD_SEEDS, // last: a cloud-pollable board for the same company wins the dedupe
]);

/** first entry wins when two groups list the same company (by normalized name or board URL) */
function dedupeSeeds(seeds: SeedCompany[]): SeedCompany[] {
  const seen = new Set<string>();
  return seeds.filter((s) => {
    const keys = [normCompany(s.name), s.careersUrl?.toLowerCase()].filter((k): k is string => !!k);
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

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
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 2,
    levelBand: "mid",
    prefs: {
      salaryFloor: 2_000_000,
      currency: "INR",
      contact: {
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        linkedin: "",
        github: "",
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
