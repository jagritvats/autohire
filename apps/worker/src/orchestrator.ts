import {
  discoverCompanies,
  pollAll,
  enrichTopMatches,
  estimatePostingSalaries,
  refreshSalaryBenchmarks,
  renormalizePostings,
  reparseStatedSalaries,
  backtestSalaryEstimates,
  calibrateSalaryConfidence,
  type BacktestReport,
  type PollStats,
  DEFAULT_TENANT,
  SEED_COMPANIES,
} from "@jobflow/pipeline";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import { loadRootEnv } from "@jobflow/db";
import { makeRepository } from "./repo.js";
import { runCloudJob, startCorpusSync } from "@jobflow/service";
import { runLoop } from "./jobs.js";
import type { Job } from "@jobflow/core";

loadRootEnv();

/**
 * Cloud orchestrator (§2, §8). The cron entrypoint. CRITICAL INVARIANT: this only
 * ever runs Tier 1-2 adapters. Tier 3 (Naukri/Glassdoor/AmbitionBox/LinkedIn) is
 * never touched here — it runs exclusively on the local agent (§7.1).
 *
 * Subcommands: discover | poll | rank | enrich | salary | salary-backtest | renormalize | (default: all).
 */

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function discover(): Promise<void> {
  const repo = await makeRepository();
  const stats = await discoverCompanies(repo, SEED_COMPANIES);
  log(`discover: seeded ${stats.seeded}, resolved ${stats.resolved}, unresolved ${stats.unresolved.length}`);
}

async function poll(): Promise<void> {
  const repo = await makeRepository();
  // tracked like every other sync, so the web app's Sources history shows the cron's runs
  let s: PollStats | null = null;
  await startCorpusSync(
    repo,
    undefined,
    async (r, hooks) => (s = await pollAll(r, { embedder: providerEmbedder(createProvider()), log, ...hooks })),
    { trigger: "scheduled", origin: "worker" },
  );
  const stats = s as PollStats | null;
  if (stats?.errors.length) log(`poll: ${stats.errors.length} errors (first: ${stats.errors[0]})`);
}

async function rank(): Promise<void> {
  const repo = await makeRepository();
  // the same per-tenant fan-out the scheduled rank job runs (never ranks an un-onboarded profile)
  const llm = createProvider();
  const job = { id: "cli", tenantId: DEFAULT_TENANT, type: "rank", runtime: "cloud", payload: { scheduled: true } } as unknown as Job;
  const r = await runCloudJob(repo, job, { embedder: providerEmbedder(llm), llm });
  log(`rank: ${r.tenants} tenant(s) ranked, ${r.skipped} not onboarded yet · ${r.scored} scored → ${r.ranked} ranked, ${r.narrated} narrated`);
}

async function enrich(): Promise<void> {
  const repo = await makeRepository();
  // enrichment writes shared company/posting data; the default tenant's top matches pick targets
  const r = await enrichTopMatches(repo, { tenantId: DEFAULT_TENANT, limit: 40 });
  log(
    `enrich: ${r.companiesEnriched} companies (comp benchmark), ${r.companyLaddersFetched} employer level ladders, ` +
      `${r.levelsMarketFetched} levels.fyi market pages, ` +
      `${r.adzunaFetched} Adzuna queries (adzuna=${r.adzunaUsed}) → ${r.estimate.estimated} estimated, ` +
      `${r.estimate.unchanged} unchanged, ${r.estimate.cleared} cleared, ${r.estimate.noEvidence} no evidence, ${r.estimate.noMarket} no pay market`,
  );
}

/**
 * Salary maintenance (§11.4): re-parse stated salaries with the current extractor (the
 * backfill after a parser fix), refresh market benchmarks, then re-price every posting that
 * states no pay. Idempotent — safe to run any time.
 */
async function salary(): Promise<void> {
  const repo = await makeRepository();
  const re = await reparseStatedSalaries(repo);
  log(`salary: re-parsed ${re.scanned} → ${re.changed} changed (${re.removed} bogus bands removed, ${re.capped} unverifiable field bands capped at medium)`);
  const b = await refreshSalaryBenchmarks(repo);
  log(`salary: ${b.levelsFetched} levels.fyi market pages fetched · adzuna=${b.adzunaEnabled}`);
  const cal = await calibrateSalaryConfidence(repo);
  log(`salary: confidence calibration ${[...cal].map(([m, c]) => `${m} ×${c.factor} (n=${c.n})`).join(", ") || "— (not enough stated ranges yet)"}`);
  const e = await estimatePostingSalaries(repo);
  log(
    `salary: ${e.considered} without stated pay → ${e.estimated} (re)estimated, ${e.unchanged} unchanged, ` +
      `${e.cleared} cleared, ${e.noEvidence} no evidence, ${e.noMarket} no pay market`,
  );
}

/**
 * Re-normalize stored postings after a location / agency parser change (§11.3): re-parse
 * each location from its stored `locationRaw`, re-read the agency flag. Idempotent; then
 * re-rank so scores see the new locations.
 */
async function renormalize(): Promise<void> {
  const repo = await makeRepository();
  const r = await renormalizePostings(repo);
  log(
    `renormalize: ${r.scanned} scanned → ${r.changed} changed (${r.locations} locations: ${r.multiCountry} now multi-country, ` +
      `${r.placed} newly placed; agency +${r.agencyFlagged} −${r.agencyCleared}; ${r.noRaw} stored without location text)`,
  );
  if (r.changed) await rank();
}

/**
 * Leave-one-out backtest of the estimator on postings that DO state pay (§11.4): is the
 * error small, and does a higher confidence score actually mean a smaller error?
 */
async function salaryBacktest(): Promise<void> {
  const repo = await makeRepository();
  printBacktest(await backtestSalaryEstimates(repo, { withoutEmployerEvidence: false }));
  // leak-free, before and after the per market × role family calibration
  printBacktest(await backtestSalaryEstimates(repo, { withoutEmployerEvidence: true, calibrated: false }));
  printBacktest(await backtestSalaryEstimates(repo, { withoutEmployerEvidence: true }));
}

function printBacktest(r: BacktestReport): void {
  const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
  console.log(`\n── ${r.mode}${r.calibrated ? "" : " (uncalibrated)"}: ${r.answered}/${r.evaluated} stated ranges re-estimated ──`);
  console.log("  bucket        n   median err   true mid in p25–p75   ranges overlap");
  for (const b of [r.overall, ...r.byConfidence, ...r.byMarket]) {
    if (!b.n) continue;
    console.log(`  ${b.label.padEnd(10)} ${String(b.n).padStart(5)}   ${pct(b.medianError)}        ${pct(b.inBand)}               ${pct(b.overlap)}`);
  }
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
  if (cmd === "salary") await salary();
  if (cmd === "salary-backtest") await salaryBacktest();
  if (cmd === "renormalize") await renormalize();
}

main()
  .then(async () => {
    // a one-shot command is done: close the store (PGlite flushes and releases its data-dir
    // lock; a pg pool's idle sockets would otherwise keep the process alive until killed)
    if (process.argv[2] === "runner") return;
    const repo = (await makeRepository()) as Awaited<ReturnType<typeof makeRepository>> & { close?: () => Promise<void> };
    await repo.close?.().catch(() => {});
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
