import {
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  seedEvidence,
} from "@jobflow/pipeline";
import { cloudAdapters } from "@jobflow/adapters";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import { makeRepository } from "./repo.js";

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
  const embedder = providerEmbedder(createProvider());

  // 1. poll registered ATS boards due for poll
  const due = await repo.listCompanies({ status: "active", dueForPoll: true });
  let fetched = 0;
  for (const c of due) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    const s = await ingestCompany(repo, c, { embedder });
    fetched += s.fetched;
  }
  log(`poll: ${due.length} companies due, ${fetched} postings ingested`);

  // 2. discovery feeds (cloud-safe tier 1-2 only) → grows the registry
  for (const adapter of cloudAdapters()) {
    if (adapter.tier !== "tier1") continue; // belt-and-suspenders: cloud cron = tier1
    if (!["remotive", "arbeitnow", "hn_whoishiring"].includes(adapter.source)) continue;
    const s = await ingestFromAdapter(repo, adapter, { query: "backend", limit: 80 }, { embedder });
    log(`  ${adapter.source}: +${s.fetched}`);
  }
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
  const r = await rebuildMatches(repo, profile, { embedder: providerEmbedder(createProvider()) });
  log(`rank: ${r.scored} scored → ${r.ranked} ranked, ${r.excluded} excluded`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "all";
  if (cmd === "discover" || cmd === "all") await discover();
  if (cmd === "poll" || cmd === "all") await poll();
  if (cmd === "rank" || cmd === "all") await rank();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
