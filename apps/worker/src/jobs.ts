import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { runNextCloudJob, STUCK_AFTER_MINUTES, type JobCtx } from "@jobflow/service";

/**
 * The worker's drain loop + self-scheduling. The job handlers themselves live in
 * @jobflow/service (`runCloudJob`), shared with the web server's in-process drainer for
 * the single-writer local store. INVARIANT: only Tier 1-2 work runs here — a 'local' job
 * is never claimed and would be refused if it were (invariant #1).
 */
/**
 * Drain loop: claim → run → complete, repeatedly. `once` drains the backlog and
 * returns; otherwise it polls every `intervalMs`. The web triggers jobs; this turns
 * them into real work and writes status back for the activity panel.
 */
export async function runLoop(
  repo: Repository,
  ctx: JobCtx,
  opts: {
    intervalMs?: number;
    once?: boolean;
    scheduleEveryHours?: number;
    /** dead-link check on the top cards every N hours between polls (0 = off). */
    livenessEveryHours?: number;
    log?: (m: string) => void;
  } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3000;
  const log = opts.log ?? ((m) => console.log(new Date().toISOString(), m));
  let lastScheduleCheck = 0;
  // a runner that died mid-job left it `running` forever — and a stuck `poll` blocks
  // the liveness scheduler (it waits for queued/running polls) indefinitely
  await requeueStuck(repo, log);
  for (;;) {
    const out = await runNextCloudJob(repo, ctx, { onStart: (job) => log(`▶ ${job.type} (${job.id.slice(0, 8)})`) });
    if (!out) {
      if (opts.once) return;
      if (Date.now() - lastScheduleCheck > 60_000) {
        lastScheduleCheck = Date.now();
        // requeue BEFORE scheduling, so a freed stuck poll counts as queued again
        await requeueStuck(repo, log);
        if (opts.scheduleEveryHours) {
          await maybeSchedulePoll(repo, opts.scheduleEveryHours, log).catch((e) => log(`schedule check failed: ${(e as Error).message}`));
          if (opts.livenessEveryHours) {
            await maybeScheduleLiveness(repo, opts.livenessEveryHours, log).catch((e) => log(`liveness schedule failed: ${(e as Error).message}`));
          }
        }
      }
      await sleep(intervalMs);
      continue;
    }
    if (out.status === "done") log(`✓ ${out.job.type} ${JSON.stringify(out.result)}`);
    else log(`✗ ${out.job.type}: ${out.error}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function requeueStuck(repo: Repository, log: (m: string) => void): Promise<void> {
  try {
    const n = await repo.requeueStuckJobs("cloud", STUCK_AFTER_MINUTES);
    if (n > 0) log(`↺ re-queued ${n} cloud job(s) stuck in 'running' > ${STUCK_AFTER_MINUTES}m (a runner died mid-job)`);
  } catch (e) {
    log(`requeue of stuck jobs failed: ${(e as Error).message}`);
  }
}

/**
 * Self-scheduling (§3 freshness). Nothing else enqueues periodic polls on a self-hosted
 * stack: the GitHub cron can't reach a local database, and the runner only drained jobs
 * someone clicked — so the corpus silently went months without a poll while still
 * showing as "active". When the last full poll is older than `everyHours`, enqueue
 * discover → poll → rank (claimed oldest-first, so they run in that order).
 */
async function maybeSchedulePoll(repo: Repository, everyHours: number, log: (m: string) => void): Promise<void> {
  const recent = await repo.listJobs(DEFAULT_TENANT, 50);
  const lastFullPoll = recent.find((j) => j.type === "poll" && !j.payload.companyId);
  const ageMs = lastFullPoll ? Date.now() - new Date(lastFullPoll.createdAt as string | Date).getTime() : Infinity;
  if (ageMs < everyHours * 3_600_000) return;
  for (const type of ["discover", "poll", "rank"] as const) {
    await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type, runtime: JOB_RUNTIME[type], payload: { scheduled: true } });
  }
  const ago = Number.isFinite(ageMs) ? `${Math.round(ageMs / 3_600_000)}h ago` : "never";
  log(`⏰ scheduled discover → poll → rank (last full poll: ${ago})`);
}

/**
 * Between full polls, re-check the top cards' own job pages every `everyHours` so a
 * filled role drops out within hours rather than at the next board poll (or the feed TTL).
 * Cheap: one GET per card, top 40 only.
 */
async function maybeScheduleLiveness(repo: Repository, everyHours: number, log: (m: string) => void): Promise<void> {
  const recent = await repo.listJobs(DEFAULT_TENANT, 50);
  if (recent.some((j) => (j.type === "poll" || j.type === "liveness") && (j.status === "queued" || j.status === "running"))) return;
  const last = recent.find((j) => j.type === "liveness");
  const ageMs = last ? Date.now() - new Date(last.createdAt as string | Date).getTime() : Infinity;
  if (ageMs < everyHours * 3_600_000) return;
  await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type: "liveness", runtime: JOB_RUNTIME.liveness, payload: { scheduled: true } });
  log("⏰ scheduled liveness check on the top cards");
}
