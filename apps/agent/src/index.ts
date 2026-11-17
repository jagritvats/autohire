import { loadRootEnv, createRepository, type Repository } from "@jobflow/db";
import { agentTenant, resolveAgentTenant } from "./tenant.js";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import type { AgentHeartbeat, Job, TenantConfig } from "@jobflow/core";
import { effectiveFlags, type EffectiveFlags } from "./flags.js";
import { AgentSession } from "./session.js";
import { handleLocalJob } from "./handlers.js";
import { localPollEveryHours, maybeScheduleLocalPolls } from "./schedule.js";

loadRootEnv();

/**
 * JobFlow local agent (§7.1) — the "hands" plane. Runs on YOUR machine, drains
 * runtime='local' jobs (Tier-3 + form-fill) through YOUR browser session, human-paced,
 * flag-guarded OFF by default, never auto-submitting. Talks to the control plane only
 * through the shared DB (jobs in, results + heartbeat out). The cloud never connects
 * to this process.
 *
 *   pnpm --filter @jobflow/agent start
 */

const VERSION = "0.1.0";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[agent]", ...a);

/** a job left `running` this long was claimed by an agent that died mid-job */
const STUCK_AFTER_MINUTES = 30;
const IDLE_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

async function heartbeat(repo: Repository, flags: EffectiveFlags): Promise<void> {
  const hb: AgentHeartbeat = {
    tenantId: agentTenant(),
    lastSeen: new Date(),
    version: VERSION,
    flags: { browserOn: flags.browserOn, mode: flags.mode, autosubmit: false, rate: flags.rate },
    enabledSources: flags.enabledSources,
  };
  await repo.upsertHeartbeat(hb);
}

/**
 * Tenant config → effective flags, never throwing. A DB blip must not kill the agent
 * (it used to crash the loop); with no config readable the web gates read as OFF, so
 * a failure can only ever make the agent MORE conservative.
 */
async function readFlagsSafe(repo: Repository, errors: ErrorLog): Promise<EffectiveFlags> {
  let config: TenantConfig | null = null;
  try {
    config = await repo.getConfig(agentTenant());
    errors.ok("config");
  } catch (e) {
    errors.fail("config", e);
  }
  return effectiveFlags(config);
}

/** Logs a failing operation once per streak (not every 3s), and its recovery. */
class ErrorLog {
  private failing = new Map<string, number>();
  fail(op: string, e: unknown): number {
    const n = (this.failing.get(op) ?? 0) + 1;
    this.failing.set(op, n);
    if (n === 1 || n % 20 === 0) log(`${op} failed (${n}× in a row): ${(e as Error)?.message ?? e}`);
    return n;
  }
  ok(op: string): void {
    const n = this.failing.get(op);
    if (n) log(`${op} recovered after ${n} failure(s)`);
    this.failing.delete(op);
  }
}

async function requeueStuck(repo: Repository): Promise<void> {
  try {
    const n = await repo.requeueStuckJobs("local", STUCK_AFTER_MINUTES);
    if (n > 0) log(`re-queued ${n} local job(s) stuck in 'running' > ${STUCK_AFTER_MINUTES}m (a previous agent died mid-job)`);
  } catch (e) {
    log("requeue of stuck jobs failed:", (e as Error).message);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log("DATABASE_URL not set — the agent needs the shared DB. Set it in .env. Exiting.");
    process.exit(1);
  }
  const repo = await createRepository();
  const tenantId = await resolveAgentTenant(repo);
  console.log(`agent: working for tenant ${tenantId.slice(0, 8)}…`);
  // blank/unset JOBFLOW_BROWSER_PROFILE → ~/.jobflow/browser-profile (resolved in autofill)
  const session = new AgentSession(process.env.JOBFLOW_BROWSER_PROFILE);
  const embedder = providerEmbedder(createProvider());
  const errors = new ErrorLog();

  const initial = await readFlagsSafe(repo, errors);
  log(`online · version ${VERSION} · browser=${initial.browserOn ? "on" : "OFF"} · mode=${initial.mode} · sources=[${initial.enabledSources.join(",") || "none"}]`);
  if (!initial.browserOn) {
    log("browser automation is OFF — heartbeating + visible in the UI, but browser jobs will be refused until enabled (env JOBFLOW_BROWSER=on + web settings).");
  }

  // a previous agent that crashed mid-job left its job `running` forever — free it
  await requeueStuck(repo);

  // heartbeat now + every 30s (flags re-read each time so the UI shows current gates)
  const beat = async () => {
    try {
      await heartbeat(repo, await readFlagsSafe(repo, errors));
      errors.ok("heartbeat");
    } catch (e) {
      errors.fail("heartbeat", e);
    }
  };
  await beat();
  setInterval(() => void beat(), 30_000);

  // unattended schedule (env JOBFLOW_LOCAL_POLL_EVERY_HOURS, 0 = off) — only acts while the
  // browser gates are on, so it inherits the default-OFF opt-in
  const everyHours = localPollEveryHours();
  log(`local poll schedule: ${everyHours > 0 ? `every ${everyHours}h per opted-in source (when the browser is on)` : "off"}`);
  let lastScheduleCheck = 0;
  let lastRequeue = Date.now();

  // drain loop — claim local jobs sequentially, run in the user's session
  for (;;) {
    let job: Job | null;
    try {
      job = await repo.claimJob("local", { tenantId: agentTenant() });
      errors.ok("claimJob");
    } catch (e) {
      // a DB error is NOT "no work" — say so, and back off instead of hammering the DB
      const n = errors.fail("claimJob", e);
      await sleep(Math.min(IDLE_MS * 2 ** Math.min(n, 5), MAX_BACKOFF_MS));
      continue;
    }
    if (!job) {
      if (Date.now() - lastRequeue > STUCK_AFTER_MINUTES * 60_000) {
        lastRequeue = Date.now();
        await requeueStuck(repo);
      }
      if (everyHours > 0 && Date.now() - lastScheduleCheck > 60_000) {
        lastScheduleCheck = Date.now();
        const flags = await readFlagsSafe(repo, errors);
        await maybeScheduleLocalPolls(repo, everyHours, flags, log).catch((e) => log("schedule check failed:", (e as Error).message));
      }
      await sleep(IDLE_MS);
      continue;
    }
    log(`▶ ${job.type} (${job.id.slice(0, 8)})`);
    const flags = await readFlagsSafe(repo, errors);
    let outcome: { status: "done" | "error"; payload: { result?: Record<string, unknown>; error?: string } };
    try {
      const result = await handleLocalJob(repo, job, { session, flags, embedder });
      outcome = { status: "done", payload: { result } };
      log(`✓ ${job.type} ${JSON.stringify(result).slice(0, 160)}`);
    } catch (e) {
      outcome = { status: "error", payload: { error: (e as Error).message } };
      log(`✗ ${job.type}: ${(e as Error).message}`);
    }
    // if the DB is down right now the job stays `running` and the stuck-job sweep
    // re-queues it later — never crash the agent over a status write
    await repo.completeJob(job.id, outcome.status, outcome.payload).catch((e) => log(`could not record ${job.type} result:`, (e as Error).message));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
