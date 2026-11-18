import type { FetchTarget, SourceAdapter } from "@jobflow/adapters";
import { normCompany, normalizePosting, type RawPosting } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { estimatePostingSalaries, toNewPosting, type PollListener, type PollStats } from "@jobflow/pipeline";
import { corpusEmbedder } from "./embedder.js";

/**
 * An OFFLINE, fully FICTIONAL corpus for demos, screenshots, videos and UI development
 * (JOBFLOW_DEMO_DATA=1). Every company and posting is invented — no live API is called, so
 * captures are reproducible and never show real people or real listings. In demo mode a
 * sync "fetches" these postings (with paced, fictional progress) and a search asks them
 * instead of the live boards; outside demo mode nothing here runs.
 */
export function demoMode(): boolean {
  return process.env.JOBFLOW_DEMO_DATA === "1";
}

export interface DemoJob {
  company: string;
  ats: "greenhouse" | "lever" | "ashby";
  title: string;
  location: string;
  daysAgo: number;
  salary?: string;
  jd: string;
}

export const DEMO_JOBS: DemoJob[] = [
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
  // Shows the newer card states: several offices in one posting, a remote role open in one
  // country only, a local-spelling city, a staffing-agency post, and one employer with many
  // roles (the feed spreads them out instead of stacking them at the top).
  { company: "Acme Pay", ats: "greenhouse", title: "Senior Backend Engineer, Payouts", location: "Hybrid - Bengaluru, India; Singapore", daysAgo: 3,
    jd: "Payouts platform: Java, Spring Boot, Kafka, PostgreSQL, distributed transactions. 4+ years of experience. Offices in Bengaluru and Singapore." },
  { company: "Acme Pay", ats: "greenhouse", title: "Backend Engineer, Risk", location: "Bengaluru, India", daysAgo: 5,
    jd: "Risk scoring services in Java and Kafka Streams, PostgreSQL, Redis. 2-5 years of experience." },
  { company: "Acme Pay", ats: "greenhouse", title: "Software Engineer, Ledger Tooling", location: "Bengaluru, India", daysAgo: 8,
    jd: "Internal tools for the ledger team: Java, TypeScript, PostgreSQL, REST APIs. 2+ years of experience." },
  { company: "Acme Pay", ats: "greenhouse", title: "Backend Engineer, Reconciliation", location: "Pune, India", daysAgo: 10,
    jd: "Reconciliation pipelines: Java, Kafka, PostgreSQL, batch and streaming. 2-4 years of experience." },
  { company: "Northwind Health", ats: "lever", title: "Backend Developer", location: "Remote - Canada", daysAgo: 4, salary: "CA$120,000 – CA$150,000",
    jd: "Backend developer for our clinical scheduling APIs: Java, Spring, PostgreSQL, AWS. 3+ years. Must live in Canada." },
  { company: "Tyrell Mobility", ats: "ashby", title: "Backend Engineer, Fleet APIs", location: "München, Deutschland (Hybrid)", daysAgo: 6, salary: "€70,000 – €90,000",
    jd: "Fleet telemetry APIs in Kotlin and Java, Kafka, PostgreSQL, Kubernetes. 3+ years. Hybrid in Munich; visa sponsorship available." },
  { company: "TalentBridge Consultancy", ats: "lever", title: "Java Developer", location: "Bengaluru, India", daysAgo: 2,
    jd: "We are hiring on behalf of our client, a leading fintech. Java, Spring Boot, Microservices, Kafka. 2-5 years. Immediate joiners preferred." },
];

function slugOf(company: string): string {
  return company.toLowerCase().replace(/[^a-z]+/g, "");
}

function rawOf(j: DemoJob, i: number, now: number): RawPosting {
  const slug = slugOf(j.company);
  return {
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
}

/** Upsert the fictional postings (all, or one company's) — idempotent, like a real poll. */
export async function seedDemoPostings(
  repo: Repository,
  opts: { company?: string; now?: number } = {},
): Promise<{ ids: string[]; created: number; updated: number; companyId: string | null }> {
  const embedder = corpusEmbedder();
  const now = opts.now ?? Date.now();
  const ids: string[] = [];
  let created = 0;
  let companyId: string | null = null;
  for (const [i, j] of DEMO_JOBS.entries()) {
    if (opts.company && j.company !== opts.company) continue;
    const slug = slugOf(j.company);
    const company = await repo.upsertCompany({
      name: j.company,
      nameNorm: normCompany(j.company),
      atsType: j.ats,
      atsSlug: slug,
      careersUrl: `https://example.com/careers/${slug}`,
      tags: ["demo"],
    });
    companyId = company.id;
    const raw = rawOf(j, i, now);
    if (!(await repo.findPostingsByAtsIds(j.ats, [raw.atsJobId])).length) created++;
    const posting = await repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embedder));
    ids.push(posting.id);
    await repo.touchPolled(company.id);
  }
  return { ids, created, updated: ids.length - created, companyId };
}

/**
 * Search in demo mode: one adapter per fictional board's ATS, answering from the fictional
 * corpus (any query word in the title or description), so a search shows invented roles only.
 */
export function demoSearchAdapters(now: number = Date.now()): SourceAdapter[] {
  const words = (t: FetchTarget) =>
    (t.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !["engineer", "developer", "the", "and"].includes(w));
  return (["greenhouse", "lever", "ashby"] as const).map((ats) => ({
    source: ats,
    tier: "tier1" as const,
    searchCaps: { keywords: true, location: false, country: false, remote: false, postedWithin: false, salaryMin: false, seniority: false, cost: "free" as const },
    toTargets: (q) => [{ query: [...q.titles, ...q.keywords].join(" ") }],
    async fetch(t: FetchTarget) {
      const w = words(t);
      return DEMO_JOBS.map((j, i) => [j, i] as const)
        .filter(([j]) => j.ats === ats)
        .filter(([j]) => !w.length || w.some((x) => `${j.title} ${j.jd}`.toLowerCase().includes(x)))
        .map(([j, i]) => rawOf(j, i, now));
    },
  }));
}

/** a fictional board that never answers — shows how a failure reads in the sync panel */
const DEMO_SLOW_BOARD = "Example Robotics";

/** JOBFLOW_DEMO_SYNC_PACE scales the demo sync's waits (default 1; 0 = instant) */
function envPace(): number {
  const raw = process.env.JOBFLOW_DEMO_SYNC_PACE;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/**
 * A demo-mode sync: the same progress events a real poll emits (steps, plan, boards in
 * flight, counts), paced so a person can watch them, over the fictional boards above. Each
 * board upserts its fictional postings; nothing is fetched from the network, retired or
 * sent anywhere.
 */
export async function demoSync(
  repo: Repository,
  hooks: { onProgress?: PollListener; signal?: AbortSignal } = {},
  opts: { pace?: number } = {},
): Promise<PollStats> {
  const pace = opts.pace ?? envPace();
  const emit: PollListener = (e) => {
    try {
      hooks.onProgress?.(e);
    } catch {
      /* progress is best effort */
    }
  };
  const wait = (ms: number) => (pace > 0 ? new Promise<void>((r) => setTimeout(r, ms * pace)) : Promise.resolve());
  const aborted = () => hooks.signal?.aborted === true;

  emit({ type: "phase", phase: "renormalize", state: "skipped" });
  emit({ type: "phase", phase: "discover", state: "start" });
  await wait(1200);
  emit({ type: "phase", phase: "discover", state: "done" });

  const companies = [...new Set(DEMO_JOBS.map((j) => j.company))];
  const boards = [...companies.slice(0, 6), DEMO_SLOW_BOARD, ...companies.slice(6)];
  const concurrency = 3;
  emit({ type: "plan", boards: boards.length, deferred: 0, notDue: 0, budgetMs: null, concurrency });
  emit({ type: "phase", phase: "boards", state: "start" });
  const stats: PollStats = { companiesPolled: 0, fetched: 0, staled: 0, feeds: {}, resolved: [], expired: 0, errors: [] };
  let next = 0;
  const worker = async () => {
    while (next < boards.length) {
      const k = next++;
      const name = boards[k]!;
      const id = `demo-board-${k + 1}`;
      if (aborted()) {
        emit({ type: "board", state: "deferred", id, name });
        continue;
      }
      emit({ type: "board", state: "start", id, name });
      if (name === DEMO_SLOW_BOARD) {
        await wait(3600);
        stats.errors.push(`${name}: timed out`);
        emit({ type: "board", state: "done", id, name, fetched: 0, created: 0, updated: 0, staled: 0, ms: 3600, error: "The operation timed out" });
        continue;
      }
      const ms = 1400 + ((k * 677) % 1500);
      await wait(ms);
      const r = await seedDemoPostings(repo, { company: name });
      stats.companiesPolled++;
      stats.fetched += r.ids.length;
      emit({ type: "board", state: "done", id, name, fetched: r.ids.length, created: r.created, updated: r.updated, staled: 0, ms });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  emit({ type: "phase", phase: "boards", state: "done" });
  for (const phase of ["feeds", "resolve"] as const) emit({ type: "phase", phase, state: "skipped" });
  // a cut-short run retires nothing (invariant #5) — and the demo never retires anything
  if (aborted()) {
    stats.cancelled = true;
    emit({ type: "phase", phase: "expire", state: "skipped" });
  } else {
    emit({ type: "phase", phase: "expire", state: "start" });
    await wait(700);
    emit({ type: "expired", count: 0 });
    emit({ type: "phase", phase: "expire", state: "done" });
  }
  for (const phase of ["fx", "reparse"] as const) emit({ type: "phase", phase, state: "skipped" });
  // the real (offline) pay estimator, as a live sync runs it
  emit({ type: "phase", phase: "process", state: "start" });
  await wait(900);
  try {
    stats.salaryEstimated = (await estimatePostingSalaries(repo)).estimated;
  } catch (e) {
    emit({ type: "error", source: "pay estimates", message: (e as Error).message });
  }
  emit({ type: "phase", phase: "process", state: "done" });
  return stats;
}
