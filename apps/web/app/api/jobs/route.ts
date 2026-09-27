import { NextResponse } from "next/server";
import { JobType, JOB_RUNTIME } from "@jobflow/core";
import { atsAdapter } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

/** Recent jobs + local-agent heartbeat (for the activity panel). */
export async function GET() {
  const repo = await getRepo();
  const [jobs, heartbeat] = await Promise.all([
    repo.listJobs(DEFAULT_TENANT, 25),
    repo.getHeartbeat(DEFAULT_TENANT),
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
  const repo = await getRepo();
  const { type, payload } = await req.json();
  const parsed = JobType.safeParse(type);
  if (!parsed.success) return NextResponse.json({ error: "invalid job type" }, { status: 400 });
  const jobType = await routePoll(repo, parsed.data, payload);
  const job = await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type: jobType, runtime: JOB_RUNTIME[jobType], payload: payload ?? {} });
  return NextResponse.json(job);
}

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
