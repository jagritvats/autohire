#!/usr/bin/env node
import { InMemoryRepository } from "@jobflow/db";
import {
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
} from "@jobflow/pipeline";
import { getAdapter } from "@jobflow/adapters";
import { DEFAULT_TENANT, SEED_COMPANIES, defaultProfile, seedEvidence } from "./seed-data.js";
import { renderMatchCard } from "./card.js";

/**
 * JobFlow CLI — runs the real pipeline against the live free APIs with the
 * in-memory repo (zero infra). `demo` exercises the whole spine:
 *   discover → poll ATS → normalize → dedup → rank → match cards.
 */

const log = (...a: unknown[]) => console.log(...a);
const hr = () => log("─".repeat(78));

async function demo(): Promise<void> {
  const repo = new InMemoryRepository();
  const profile = defaultProfile();
  await repo.saveProfile(profile);
  for (const e of seedEvidence()) await repo.saveEvidence(e);

  log("\n\x1b[1mJobFlow demo\x1b[0m — live pipeline on free APIs, in-memory store\n");

  // ── 1. discover: seed registry + resolve ATS slugs ──
  log("① Discovery — seeding registry & resolving ATS boards…");
  const disc = await discoverCompanies(repo, SEED_COMPANIES);
  log(`   seeded ${disc.seeded}, resolved ${disc.resolved} via ATS Detector` +
      (disc.unresolved.length ? `, unresolved: ${disc.unresolved.join(", ")}` : ""));

  // ── 2. poll every resolved company's ATS ──
  log("\n② Ingestion — polling resolved ATS boards…");
  const companies = await repo.listCompanies({ status: "active" });
  let totalFetched = 0;
  for (const c of companies) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    const s = await ingestCompany(repo, c, { limit: 60 });
    totalFetched += s.fetched;
    if (s.fetched) log(`   ${c.name.padEnd(16)} ${c.atsType.padEnd(10)} ${s.fetched} postings`);
  }

  // ── 3. discovery via aggregators + HN (grows registry, adds coverage) ──
  log("\n③ Discovery feeds — HN 'Who is Hiring' + Remotive…");
  const hn = await ingestFromAdapter(repo, getAdapter("hn_whoishiring")!, { query: "backend", limit: 40 });
  log(`   HN who-is-hiring: ${hn.fetched} postings`);
  const remotive = await ingestFromAdapter(repo, getAdapter("remotive")!, { query: "backend", limit: 40 });
  log(`   Remotive:         ${remotive.fetched} postings`);
  totalFetched += hn.fetched + remotive.fetched;

  // ── 4. rank ──
  log("\n④ Matching — embed + dedup + soft-weighted score + rule check…");
  const result = await rebuildMatches(repo, profile);
  log(`   ${totalFetched} fetched → ${result.scored} canonical (deduped) → ` +
      `${result.ranked} ranked, ${result.excluded} hard-excluded`);

  // ── 5. match cards ──
  hr();
  log("\x1b[1m  TOP MATCHES\x1b[0m  (the card is the product — §11.6)");
  hr();
  const matches = await repo.listMatches(DEFAULT_TENANT, 12);
  if (!matches.length) {
    log("  No matches — APIs may be unreachable from this network.");
  }
  matches.forEach((m, i) => {
    log(renderMatchCard(m, i + 1));
    log("");
  });
  hr();
  log(`\nRegistry now holds ${(await repo.listCompanies()).length} companies, ` +
      `${(await repo.listActivePostings()).length} active postings.\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "demo";
  switch (cmd) {
    case "demo":
      await demo();
      break;
    default:
      log(`Unknown command: ${cmd}. Try: demo`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
