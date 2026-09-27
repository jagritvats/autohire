import { loadRootEnv, createRepository, type Repository } from "@jobflow/db";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import type { AgentHeartbeat } from "@jobflow/core";
import { effectiveFlags } from "./flags.js";
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

async function heartbeat(repo: Repository): Promise<void> {
  const config = await repo.getConfig(DEFAULT_TENANT);
  const flags = effectiveFlags(config);
  const hb: AgentHeartbeat = {
    tenantId: DEFAULT_TENANT,
    lastSeen: new Date(),
    version: VERSION,
    flags: { browserOn: flags.browserOn, mode: flags.mode, autosubmit: false, rate: flags.rate },
    enabledSources: flags.enabledSources,
  };
  await repo.upsertHeartbeat(hb);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    log("DATABASE_URL not set — the agent needs the shared DB. Set it in .env. Exiting.");
    process.exit(1);
  }
  const repo = await createRepository();
  const session = new AgentSession(process.env.JOBFLOW_BROWSER_PROFILE);
  const embedder = providerEmbedder(createProvider());

  const initial = effectiveFlags(await repo.getConfig(DEFAULT_TENANT));
  log(`online · version ${VERSION} · browser=${initial.browserOn ? "on" : "OFF"} · mode=${initial.mode} · sources=[${initial.enabledSources.join(",") || "none"}]`);
  if (!initial.browserOn) {
    log("browser automation is OFF — heartbeating + visible in the UI, but browser jobs will be refused until enabled (env JOBFLOW_BROWSER=on + web settings).");
  }

  // heartbeat now + every 30s
  await heartbeat(repo).catch((e) => log("heartbeat error:", (e as Error).message));
  setInterval(() => heartbeat(repo).catch(() => {}), 30_000);

  // unattended schedule (env JOBFLOW_LOCAL_POLL_EVERY_HOURS, 0 = off) — only acts while the
  // browser gates are on, so it inherits the default-OFF opt-in
  const everyHours = localPollEveryHours();
  log(`local poll schedule: ${everyHours > 0 ? `every ${everyHours}h per opted-in source (when the browser is on)` : "off"}`);
  let lastScheduleCheck = 0;

  // drain loop — claim local jobs sequentially, run in the user's session
  let idleLogged = false;
  for (;;) {
    const job = await repo.claimJob("local").catch(() => null);
    if (!job) {
      if (!idleLogged) {
        idleLogged = true;
      }
      if (everyHours > 0 && Date.now() - lastScheduleCheck > 60_000) {
        lastScheduleCheck = Date.now();
        const flags = effectiveFlags(await repo.getConfig(DEFAULT_TENANT).catch(() => null));
        await maybeScheduleLocalPolls(repo, everyHours, flags, log).catch((e) => log("schedule check failed:", (e as Error).message));
      }
      await sleep(3000);
      continue;
    }
    idleLogged = false;
    log(`▶ ${job.type} (${job.id.slice(0, 8)})`);
    const flags = effectiveFlags(await repo.getConfig(DEFAULT_TENANT));
    try {
      const result = await handleLocalJob(repo, job, { session, flags, embedder });
      await repo.completeJob(job.id, "done", { result });
      log(`✓ ${job.type} ${JSON.stringify(result).slice(0, 160)}`);
    } catch (e) {
      await repo.completeJob(job.id, "error", { error: (e as Error).message });
      log(`✗ ${job.type}: ${(e as Error).message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
