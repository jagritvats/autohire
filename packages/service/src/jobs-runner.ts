import type { Job, Profile } from "@jobflow/core";
import { createProvider, redactSecrets, rerankMatch, type LlmProvider } from "@jobflow/llm";
import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { tenantProvider, operatorLlmAllowed } from "./tailor.js";
import { corpusEmbedder } from "./embedder.js";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  isOnboarded,
  discoverCompanies,
  pollAll,
  rebuildMatches,
  enrichTopMatches,
  recheckPostings,
  checkLiveness,
  type SeedCompany,
  type Embedder,
  type Narrator,
} from "@jobflow/pipeline";

/**
 * Cloud job handlers (§ control plane Phase 2). The web enqueues jobs; the worker's runner
 * (Postgres) or the web server's in-process drainer (local single-writer store) runs the
 * runtime='cloud' ones through here. INVARIANT: only Tier 1-2 work runs here — a 'local'
 * job type is refused, never executed (invariant #1).
 */
export interface JobCtx {
  embedder: Embedder;
  /** the configured LLM — writes the re-rank narratives for the top matches */
  llm?: LlmProvider;
}

/**
 * The LLM re-ranker for a rank run (§11.6): top-N only (JOBFLOW_RERANK_TOP, default 15,
 * 0 = off), never with the offline echo provider (its "[echo]" text isn't a write-up).
 * Narratives are cached per posting, so a paid model only sees new or changed top cards.
 */
export async function narratorFor(repo: Repository, llm: LlmProvider | undefined, profile: Profile): Promise<Narrator | undefined> {
  // a blank value (Actions var / docker env_file) means "default", not 0 = off
  const top = Number(process.env.JOBFLOW_RERANK_TOP?.trim() || 15);
  if (!llm || llm.name === "echo" || !(top > 0)) return undefined;
  const evidence = await repo.listEvidence(profile.tenantId);
  return {
    model: llm.name,
    top,
    narrate: (posting, prior) => rerankMatch(llm, profile, evidence, { posting, priorNotes: prior }),
  };
}

/** tenants worth ranking: active in the last 30 days (or never-tracked single-user ones). */
export async function rankableTenants(repo: Repository): Promise<string[]> {
  const tenants = await repo.listTenants({ activeSinceDays: 30 });
  const ids = tenants.map((t) => t.id);
  return ids.length ? ids : [DEFAULT_TENANT];
}

/**
 * Rank the shared corpus for one tenant, narrated by THAT tenant's model (their own key;
 * the operator's only when allowed). Never ranks an un-onboarded profile — there's no
 * candidate to score yet, so any score would be invented.
 */
export async function rankTenantNarrated(repo: Repository, tenantId: string, ctx: JobCtx) {
  const profile = await repo.getProfile(tenantId);
  if (!profile || !isOnboarded(profile)) return null;
  const config = await repo.getConfig(tenantId);
  const llm = config ? tenantProvider(config) : operatorLlmAllowed() ? ctx.llm : undefined;
  const narrator = await narratorFor(repo, llm, profile);
  return rebuildMatches(repo, profile, { embedder: ctx.embedder, narrator });
}

/** Is this a job the cloud side (worker / web drainer) may run? Never a local-agent job. */
export function isCloudJob(job: Pick<Job, "type" | "runtime">): boolean {
  return JOB_RUNTIME[job.type] === "cloud" && job.runtime === "cloud";
}

export async function runCloudJob(repo: Repository, job: Job, ctx: JobCtx): Promise<Record<string, unknown>> {
  if (!isCloudJob(job)) {
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
      // a scheduled rank (after the shared corpus was polled) re-ranks EVERY active tenant;
      // a rank a user asked for re-ranks only theirs
      const tenantIds = job.payload.scheduled ? await rankableTenants(repo) : [job.tenantId];
      const out: Record<string, unknown> = { tenants: 0, skipped: 0, scored: 0, ranked: 0, narrated: 0 };
      for (const tenantId of tenantIds) {
        const r = await rankTenantNarrated(repo, tenantId, ctx);
        if (!r) {
          (out.skipped as number)++;
          continue;
        }
        (out.tenants as number)++;
        out.scored = (out.scored as number) + r.scored;
        out.ranked = (out.ranked as number) + r.ranked;
        out.narrated = (out.narrated as number) + r.narrated;
      }
      return out;
    }
    case "enrich_t1": {
      const limit = (job.payload.limit as number | undefined) ?? 40;
      const r = await enrichTopMatches(repo, { tenantId: job.tenantId, limit });
      return {
        companiesEnriched: r.companiesEnriched,
        companyLaddersFetched: r.companyLaddersFetched,
        levelsMarketFetched: r.levelsMarketFetched,
        adzunaFetched: r.adzunaFetched,
        adzuna: r.adzunaUsed,
        postingsEstimated: r.postingsEstimated,
        estimateUnchanged: r.estimate.unchanged,
        estimateNoMarket: r.estimate.noMarket,
      };
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
    case "liveness": {
      // dead-link check on the top cards between polls (§3); retired cards leave the feed
      // at once (listMatches only returns active postings), so no re-rank is needed
      // the union of every active tenant's top cards (a dead link is dead for everyone)
      const limit = (job.payload.limit as number | undefined) ?? 40;
      const totals: Record<string, number> = {};
      for (const tenantId of await rankableTenants(repo)) {
        const r = await checkLiveness(repo, { tenantId, limit });
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
      }
      return totals;
    }
    case "purge": {
      // Bulk soft-delete (markStale) / hard-delete postings older than a threshold.
      const olderThanDays = Number(job.payload.olderThanDays);
      // a purge without a threshold must not run: NaN made the in-memory store retire EVERY
      // posting (and Postgres reject the interval) — fail it loudly instead
      if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
        throw new Error("purge needs payload.olderThanDays (a positive number of days)");
      }
      const field = job.payload.field === "firstSeen" ? "firstSeen" : "lastSeen";
      const hard = job.payload.hard === true;
      const n = await repo.purgeOldPostings({ olderThanDays, field, hard });
      return { purged: n };
    }
    default:
      throw new Error(`Unhandled cloud job type: ${job.type}`);
  }
}

let operatorCtx: JobCtx | null = null;
/**
 * The context the worker builds at start: the corpus embedder (the operator's provider,
 * so profile and posting vectors share one model) and the operator's LLM for narratives
 * (used only when the tenant has no model of its own and operatorLlmAllowed()).
 */
export function operatorJobCtx(): JobCtx {
  operatorCtx ??= { embedder: corpusEmbedder(), llm: createProvider() };
  return operatorCtx;
}

/** cloud jobs (a full poll can take a while) count as orphaned after an hour `running` */
export const STUCK_AFTER_MINUTES = 60;

export interface CloudJobOutcome {
  job: Job;
  status: "done" | "error";
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Claim ONE queued cloud job, run it, and write its result (or its error, with any key
 * masked — job rows are shown in the activity list) back. Null when nothing was queued.
 * Only ever claims runtime='cloud' (invariant #1): a local-agent job is never claimed
 * here, so it stays queued for the agent.
 */
export async function runNextCloudJob(
  repo: Repository,
  ctx: JobCtx,
  opts: { onStart?: (job: Job) => void } = {},
): Promise<CloudJobOutcome | null> {
  const job = await repo.claimJob("cloud");
  if (!job) return null;
  opts.onStart?.(job);
  try {
    const result = await runCloudJob(repo, job, ctx);
    await repo.completeJob(job.id, "done", { result });
    return { job, status: "done", result };
  } catch (e) {
    const error = redactSecrets(e instanceof Error ? e.message : String(e));
    await repo.completeJob(job.id, "error", { error });
    return { job, status: "error", error };
  }
}

export interface CloudJobDrainer {
  /** check the queue now (e.g. right after enqueueing) instead of at the next tick */
  wake(): void;
  stop(): void;
  /** resolves once the current drain pass has finished (tests) */
  idle(): Promise<void>;
}

/**
 * An in-process drainer for the single-writer local store (§ local-first): the web server
 * owns the PGlite database, so a separate worker can't open it — without this, the
 * Maintenance buttons queued work nothing would ever run. Runs cloud jobs one at a time and
 * keeps going while jobs exist; when idle it costs one claim query per `intervalMs`.
 * Re-queues jobs a previous server left `running` before its first pass. Never touches a
 * local-agent job (see runNextCloudJob).
 */
export function startCloudJobDrainer(
  repo: Repository,
  ctx: JobCtx | (() => JobCtx),
  opts: { intervalMs?: number; log?: (m: string) => void } = {},
): CloudJobDrainer {
  const intervalMs = opts.intervalMs ?? 3000;
  const log = opts.log ?? (() => {});
  const getCtx = typeof ctx === "function" ? ctx : () => ctx;
  let stopped = false;
  let running: Promise<void> | null = null;
  let requeued: Promise<void> | null = null;

  const drain = async () => {
    requeued ??= repo
      .requeueStuckJobs("cloud", STUCK_AFTER_MINUTES)
      .then((n) => {
        if (n > 0) log(`re-queued ${n} cloud job(s) a previous server left running`);
      })
      .catch(() => {});
    await requeued;
    while (!stopped) {
      const out = await runNextCloudJob(repo, getCtx());
      if (!out) return;
      log(out.status === "done" ? `✓ ${out.job.type} ${JSON.stringify(out.result)}` : `✗ ${out.job.type}: ${out.error}`);
    }
  };
  const wake = () => {
    if (stopped || running) return;
    running = drain()
      .catch((e: unknown) => log(`job drain failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(wake, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  wake();
  return {
    wake,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async idle() {
      while (running) await running;
    },
  };
}
