import { NextResponse } from "next/server";
import { JobType, JOB_RUNTIME } from "@jobflow/core";
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
  const runtime = JOB_RUNTIME[parsed.data];
  const job = await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type: parsed.data, runtime, payload: payload ?? {} });
  return NextResponse.json(job);
}
