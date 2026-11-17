import { NextResponse } from "next/server";
import { JobType, JOB_RUNTIME } from "@jobflow/core";
import { atsAdapter } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Recent jobs + local-agent heartbeat (for the activity panel). */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const [jobs, heartbeat] = await Promise.all([
    repo.listJobs(auth.tenantId, 25),
    repo.getHeartbeat(auth.tenantId),
  ]);
  const agentOnline = heartbeat ? Date.now() - new Date(heartbeat.lastSeen as string).getTime() < 90_000 : false;
  return NextResponse.json({ jobs, heartbeat, agentOnline });
}

/**
 * Enqueue a job. CLOUD jobs (discover/poll/rank/enrich_t1) run on the worker. LOCAL
 * jobs (tier3_poll/enrich_t3/form_fill) are picked up by the local agent in YOUR
 * session — the agent enforces the flags/opt-ins and the review gate; the web never
 * runs them. Dispatching a local job while the agent is offline just queues it.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { type, payload } = await req.json();
  const parsed = JobType.safeParse(type);
  if (!parsed.success) return NextResponse.json({ error: "invalid job type" }, { status: 400 });
  const jobType = await routePoll(repo, parsed.data, payload);
  // instance-wide jobs touch the SHARED corpus — on a multi-user instance only an admin queues them
  const companyPoll = jobType === "poll" && typeof payload?.companyId === "string";
  if (GLOBAL_JOBS.has(jobType) && !companyPoll && auth.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can run instance-wide jobs; your feed re-ranks after each scheduled poll." }, { status: 403 });
  }
  const job = await repo.enqueueJob({ tenantId: auth.tenantId, type: jobType, runtime: JOB_RUNTIME[jobType], payload: payload ?? {} });
  return NextResponse.json(job);
}

const GLOBAL_JOBS = new Set<JobType>(["discover", "poll", "recheck", "purge", "liveness"]);

/**
 * "Poll this company" for a board with no cloud adapter (Darwinbox is Cloudflare-blocked
 * for servers) goes to the local agent's `local_board_poll` instead — the cloud poll
 * could only fail on it (invariant #1: the cloud never gets a local-only adapter).
 */
async function routePoll(repo: Repository, type: JobType, payload: Record<string, unknown> | undefined): Promise<JobType> {
  const companyId = payload?.companyId;
  if (type !== "poll" || typeof companyId !== "string") return type;
  const company = await repo.getCompany(companyId);
  return company && company.atsType !== "unknown" && !atsAdapter(company.atsType) ? "local_board_poll" : type;
}
