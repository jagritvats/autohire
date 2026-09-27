import {
  discoverCompanies,
  pollAll,
  rebuildMatches,
  enrichTopMatches,
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  seedEvidence,
} from "@jobflow/pipeline";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import { loadRootEnv } from "@jobflow/db";
import { makeRepository } from "./repo.js";
import { narratorFor, runLoop } from "./jobs.js";

loadRootEnv();

/**
 * Cloud orchestrator (§2, §8). The cron entrypoint. CRITICAL INVARIANT: this only
 * ever runs Tier 1-2 adapters. Tier 3 (Naukri/Glassdoor/AmbitionBox/LinkedIn) is
 * never touched here — it runs exclusively on the local agent (§7.1).
 *
 * Subcommands: discover | poll | rank | (default: all).
 */

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function discover(): Promise<void> {
  const repo = await makeRepository();
  const stats = await discoverCompanies(repo, SEED_COMPANIES);
  log(`discover: seeded ${stats.seeded}, resolved ${stats.resolved}, unresolved ${stats.unresolved.length}`);
}

async function poll(): Promise<void> {
  const repo = await makeRepository();
  const s = await pollAll(repo, { embedder: providerEmbedder(createProvider()), log });
  if (s.errors.length) log(`poll: ${s.errors.length} errors (first: ${s.errors[0]})`);
}

async function rank(): Promise<void> {
  const repo = await makeRepository();
  // ensure a profile/evidence exists (single-tenant default for v1)
  let profile = await repo.getProfile(DEFAULT_TENANT);
  if (!profile) {
    profile = defaultProfile();
    await repo.saveProfile(profile);
    for (const e of seedEvidence()) await repo.saveEvidence(e);
  }
  const llm = createProvider();
  const r = await rebuildMatches(repo, profile, { embedder: providerEmbedder(llm), narrator: await narratorFor(repo, llm, profile) });
  log(`rank: ${r.scored} scored → ${r.ranked} ranked, ${r.excluded} excluded, ${r.narrated} narrated (${r.narratedFresh} new)`);
}

async function enrich(): Promise<void> {
  const repo = await makeRepository();
  const r = await enrichTopMatches(repo, { tenantId: DEFAULT_TENANT, limit: 40 });
  log(`enrich: ${r.companiesEnriched} companies (comp benchmark), ${r.postingsEstimated} postings estimated · adzuna=${r.adzunaUsed}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "all";
  // `runner` = long-lived drain loop for web-enqueued jobs (the command plane).
  // `runner --once` drains the current backlog and exits (good for cron + CI).
  if (cmd === "runner") {
    const repo = await makeRepository();
    const llm = createProvider();
    const ctx = { embedder: providerEmbedder(llm), llm };
    const once = process.argv.includes("--once");
    log(`job runner started${once ? " (once)" : ""}`);
    // self-schedule discover → poll → rank so a self-hosted stack stays fresh without an
    // external cron (0 disables; the GitHub Actions cron covers hosted DBs).
    const everyHours = Number(process.env.JOBFLOW_POLL_EVERY_HOURS ?? 6);
    const livenessEveryHours = Number(process.env.JOBFLOW_LIVENESS_EVERY_HOURS ?? 2);
    await runLoop(repo, ctx, {
      once,
      scheduleEveryHours: once ? 0 : everyHours,
      livenessEveryHours: once ? 0 : livenessEveryHours,
      log: (m) => log(m),
    });
    return;
  }
  // one-shot orchestration (the cron path)
  if (cmd === "discover" || cmd === "all") await discover();
  if (cmd === "poll" || cmd === "all") await poll();
  if (cmd === "rank" || cmd === "all") await rank();
  if (cmd === "enrich" || cmd === "all") await enrich();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
