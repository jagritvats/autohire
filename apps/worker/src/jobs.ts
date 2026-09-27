import type { Job } from "@jobflow/core";
import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  discoverCompanies,
  pollAll,
  rebuildMatches,
  enrichTopMatches,
  recheckPostings,
  type SeedCompany,
  type Embedder,
} from "@jobflow/pipeline";

/**
 * Cloud job handlers (§ control plane Phase 2). The web enqueues jobs; this drains
 * runtime='cloud' ones. INVARIANT: only Tier 1-2 work runs here — a 'local' job type
 * arriving on the cloud runner is refused, never executed (invariant #1).
 */
export interface JobCtx {
  embedder: Embedder;
}

export async function handleJob(repo: Repository, job: Job, ctx: JobCtx): Promise<Record<string, unknown>> {
  if (JOB_RUNTIME[job.type] !== "cloud") {
    throw new Error(`Refusing ${job.type}: it is a LOCAL-agent job, never run on the cloud runner (invariant #1).`);
  }
  switch (job.type) {
    case "discover": {
      const seeds = (job.payload.companies as SeedCompany[] | undefined) ?? SEED_COMPANIES;
      const s = await discoverCompanies(repo, seeds);
      return { seeded: s.seeded, resolved: s.resolved, unresolved: s.unresolved };
    }
    case "poll": {
      // one shared routine (boards → feeds → resolve shells → expire); a single company
      // when the registry UI asks for "poll now"
      const r = await pollAll(repo, { embedder: ctx.embedder, companyId: job.payload.companyId as string | undefined });
      return {
        companiesPolled: r.companiesPolled,
        postingsFetched: r.fetched,
        staled: r.staled,
        feeds: r.feeds,
        resolved: r.resolved,
        expired: r.expired,
      };
    }
    case "rank": {
      const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
      const r = await rebuildMatches(repo, profile, { embedder: ctx.embedder });
      return { scored: r.scored, ranked: r.ranked, excluded: r.excluded };
    }
    case "enrich_t1": {
      const limit = (job.payload.limit as number | undefined) ?? 40;
      const r = await enrichTopMatches(repo, { tenantId: DEFAULT_TENANT, limit });
      return { companiesEnriched: r.companiesEnriched, postingsEstimated: r.postingsEstimated, adzuna: r.adzunaUsed };
    }
    case "recheck": {
      // Re-verify postings by re-polling their boards (§3): refetch → bump lastSeen →
      // markStale for any that disappeared. Explicit ids > a company's postings > all active.
      const postingIds = job.payload.postingIds as string[] | undefined;
      const companyId = job.payload.companyId as string | undefined;
      let ids: string[] = Array.isArray(postingIds) ? postingIds : [];
      if (ids.length === 0 && companyId) {
        ids = (await repo.listPostingsByCompany(companyId)).map((p) => p.id);
      }
      if (ids.length === 0) {
        ids = (await repo.listActivePostings()).map((p) => p.id);
      }
      const stats = await recheckPostings(repo, ids, { embedder: ctx.embedder });
      return { ...stats };
    }
    case "purge": {
      // Bulk soft-delete (markStale) / hard-delete postings older than a threshold.
      const olderThanDays = job.payload.olderThanDays as number;
      const field = job.payload.field as "lastSeen" | "firstSeen" | undefined;
      const hard = job.payload.hard as boolean | undefined;
      const n = await repo.purgeOldPostings({ olderThanDays, field, hard });
      return { purged: n };
    }
    default:
      throw new Error(`Unhandled cloud job type: ${job.type}`);
  }
}

/**
 * Drain loop: claim → run → complete, repeatedly. `once` drains the backlog and
 * returns; otherwise it polls every `intervalMs`. The web triggers jobs; this turns
 * them into real work and writes status back for the activity panel.
 */
export async function runLoop(
  repo: Repository,
  ctx: JobCtx,
  opts: { intervalMs?: number; once?: boolean; scheduleEveryHours?: number; log?: (m: string) => void } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3000;
  const log = opts.log ?? ((m) => console.log(new Date().toISOString(), m));
  let lastScheduleCheck = 0;
  for (;;) {
    const job = await repo.claimJob("cloud");
    if (!job) {
      if (opts.once) return;
      if (opts.scheduleEveryHours && Date.now() - lastScheduleCheck > 60_000) {
        lastScheduleCheck = Date.now();
        await maybeSchedulePoll(repo, opts.scheduleEveryHours, log).catch((e) => log(`schedule check failed: ${(e as Error).message}`));
      }
      await sleep(intervalMs);
      continue;
    }
    log(`▶ ${job.type} (${job.id.slice(0, 8)})`);
    try {
      const result = await handleJob(repo, job, ctx);
      await repo.completeJob(job.id, "done", { result });
      log(`✓ ${job.type} ${JSON.stringify(result)}`);
    } catch (e) {
      await repo.completeJob(job.id, "error", { error: (e as Error).message });
      log(`✗ ${job.type}: ${(e as Error).message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
