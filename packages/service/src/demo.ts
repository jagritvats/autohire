import { randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { normCompany, normalizePosting, type Application, type RawPosting } from "@jobflow/core";
import { toNewPosting } from "@jobflow/pipeline";
import { corpusEmbedder } from "./embedder.js";
import { rankTenant } from "./feed.js";
import { loadSampleProfile } from "./tenant.js";

/**
 * An OFFLINE, fully FICTIONAL corpus for demos, screenshots and UI development
 * (JOBFLOW_DEMO_DATA=1). Every company and posting is invented — no live API is called, so
 * screenshots are reproducible and never show real people or real listings.
 */
interface DemoJob {
  company: string;
  ats: "greenhouse" | "lever" | "ashby";
  title: string;
  location: string;
  daysAgo: number;
  salary?: string;
  jd: string;
}

const JOBS: DemoJob[] = [
  { company: "Acme Pay", ats: "greenhouse", title: "Backend Engineer, Ledger", location: "Remote (Worldwide)", daysAgo: 2, salary: "₹30L – ₹45L per annum",
    jd: "We're hiring a backend engineer for our double-entry ledger. Java, Kafka, PostgreSQL, idempotent APIs, distributed systems. 2-5 years of experience. Remote worldwide." },
  { company: "Globex Cloud", ats: "ashby", title: "Platform Engineer", location: "Bengaluru, India (Hybrid)", daysAgo: 4,
    jd: "Build our internal developer platform: Kubernetes, Terraform, Go or Java, CI/CD, observability. 3+ years experience. Hybrid in Bengaluru." },
  { company: "Initech Labs", ats: "lever", title: "Software Engineer II, Payments", location: "Pune, India", daysAgo: 6, salary: "₹25L – ₹35L",
    jd: "Payments platform team. TypeScript/Node.js, PostgreSQL, Redis, event-driven microservices, REST. 2-4 years of experience." },
  { company: "Umbrella Data", ats: "greenhouse", title: "Senior Data Engineer", location: "Remote (US only)", daysAgo: 3, salary: "$170,000 – $210,000",
    jd: "Senior data engineer: Spark, Airflow, Python, Snowflake. 6+ years of experience. Must be located in the United States." },
  { company: "Hooli Infra", ats: "ashby", title: "Site Reliability Engineer", location: "Remote (APAC)", daysAgo: 9,
    jd: "SRE for our storage fleet: Linux, Kubernetes, Prometheus, Go, incident response. 3+ years. Remote within APAC time zones." },
  { company: "Stark Fintech", ats: "lever", title: "Backend Engineer (Kafka)", location: "Mumbai, India", daysAgo: 1,
    jd: "Real-time risk engine on Kafka Streams and Java/Spring. PostgreSQL, Redis, Docker. 1-3 years of experience." },
  { company: "Wayne Logistics", ats: "greenhouse", title: "Full-stack Engineer", location: "Remote (Worldwide)", daysAgo: 12,
    jd: "Full-stack role: React, TypeScript, Node.js, PostgreSQL. Ship features end to end. 2+ years." },
  { company: "Cyberdyne AI", ats: "ashby", title: "ML Platform Engineer", location: "Hyderabad, India", daysAgo: 5, salary: "₹40L – ₹60L",
    jd: "Serve and monitor ML models at scale: Python, Kubernetes, Kafka, feature stores, distributed systems. 4+ years of experience." },
  { company: "Soylent Systems", ats: "lever", title: "Staff Backend Engineer", location: "Remote (EU only)", daysAgo: 7, salary: "€110,000 – €140,000",
    jd: "Staff engineer for our order platform: Go, PostgreSQL, Kafka, gRPC. 9+ years of experience. EU residents only." },
  { company: "Vandelay Commerce", ats: "greenhouse", title: "Software Engineer, Checkout", location: "Bengaluru, India", daysAgo: 15,
    jd: "Checkout services in Java and Kotlin, MySQL, Redis, REST and gRPC. 2-5 years. Bengaluru office." },
  { company: "Pied Piper", ats: "ashby", title: "Backend Engineer, Compression APIs", location: "Remote (Worldwide)", daysAgo: 2,
    jd: "Public APIs for our compression platform: TypeScript, Node.js, PostgreSQL, Redis, AWS. 2+ years experience." },
  { company: "Massive Dynamic", ats: "lever", title: "Engineering Manager, Infrastructure", location: "Pune, India", daysAgo: 20,
    jd: "Lead a team of 8 infrastructure engineers. Kubernetes, AWS, Terraform. 10+ years of experience including 3 years managing." },
];

let seeded = false;

/** Seed the fictional corpus + sample candidate (idempotent per process). */
export async function seedDemoCorpus(repo: Repository, tenantId: string): Promise<void> {
  if (seeded) return;
  seeded = true;
  const embedder = corpusEmbedder();
  const now = Date.now();
  const ids: string[] = [];
  for (const [i, j] of JOBS.entries()) {
    const slug = j.company.toLowerCase().replace(/[^a-z]+/g, "");
    const company = await repo.upsertCompany({
      name: j.company,
      nameNorm: normCompany(j.company),
      atsType: j.ats,
      atsSlug: slug,
      careersUrl: `https://example.com/careers/${slug}`,
      tags: ["demo"],
    });
    const raw: RawPosting = {
      source: j.ats,
      tier: "tier1",
      atsType: j.ats,
      atsJobId: `demo-${i + 1}`,
      companyName: j.company,
      companySlug: slug,
      title: j.title,
      jdText: j.jd,
      jdHtml: null,
      locationRaw: j.location,
      applyUrl: `https://example.com/careers/${slug}/jobs/${i + 1}`,
      salaryRaw: j.salary ?? null,
      postedAt: new Date(now - j.daysAgo * 86_400_000),
      fetchedAt: new Date(now),
      raw: {},
    };
    const posting = await repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embedder));
    ids.push(posting.id);
    await repo.touchPolled(company.id);
  }
  await loadSampleProfile(repo, tenantId);
  await rankTenant(repo, tenantId);
  // a few tracked applications so the pipeline view has something to show
  const statuses: Application["status"][] = ["applied", "interviewing", "ready", "saved"];
  for (const [i, status] of statuses.entries()) {
    const postingId = ids[i];
    if (!postingId) continue;
    await repo.upsertApplication({
      id: randomUUID(), tenantId, postingId, status, appliedVia: status === "applied" || status === "interviewing" ? "manual" : null,
      tailoredResumeUrl: null, resumeVariant: null, answers: {}, submittedAt: null,
      nextAction: status === "interviewing" ? "System design round" : null,
      nextActionAt: status === "interviewing" ? new Date(now + 3 * 86_400_000) : null, outcome: null,
    });
  }
}
