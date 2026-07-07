import type { Job } from "@jobflow/core";
import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
  enrichTopMatches,
  type SeedCompany,
  type Embedder,
} from "@jobflow/pipeline";
import { cloudAdapters } from "@jobflow/adapters";

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
      const companyId = job.payload.companyId as string | undefined;
      const companies = companyId
        ? (await repo.listCompanies()).filter((c) => c.id === companyId)
        : await repo.listCompanies({ status: "active", dueForPoll: true });
      let fetched = 0;
      let polled = 0;
      for (const c of companies) {
        if (c.atsType === "unknown" || !c.atsSlug) continue;
        const r = await ingestCompany(repo, c, { embedder: ctx.embedder });
        fetched += r.fetched;
        polled++;
      }
      // discovery feeds (tier-1 only) unless polling a single company
      if (!companyId) {
        for (const adapter of cloudAdapters()) {
          if (adapter.tier !== "tier1") continue;
          if (!["remotive", "arbeitnow", "hn_whoishiring"].includes(adapter.source)) continue;
          const r = await ingestFromAdapter(repo, adapter, { query: "backend", limit: 80 }, { embedder: ctx.embedder });
          fetched += r.fetched;
        }
      }
      return { companiesPolled: polled, postingsFetched: fetched };
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
  opts: { intervalMs?: number; once?: boolean; log?: (m: string) => void } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3000;
  const log = opts.log ?? ((m) => console.log(new Date().toISOString(), m));
  for (;;) {
    const job = await repo.claimJob("cloud");
    if (!job) {
      if (opts.once) return;
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
