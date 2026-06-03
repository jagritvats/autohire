#!/usr/bin/env node
import { InMemoryRepository } from "@jobflow/db";
import {
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
} from "@jobflow/pipeline";
import { getAdapter } from "@jobflow/adapters";
import { createProvider, rerankMatch, tailorResume, answerQuestion } from "@jobflow/llm";
import { buildFillPlan, renderDryRun, type ApplicantData } from "@jobflow/autofill";
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

  // ── 6. recommendations: LLM re-rank narrative on the top match ──
  const top = matches[0];
  if (top) {
    const llm = createProvider(); // echo by default → runs offline
    const evidence = await repo.listEvidence(DEFAULT_TENANT);
    hr();
    log(`\x1b[1m  RE-RANK NARRATIVE\x1b[0m  (LLM: ${llm.name}) — top match`);
    hr();
    const narrative = await rerankMatch(llm, profile, evidence, {
      posting: top.posting,
      priorNotes: { stackNote: top.stackNote, levelNote: top.levelNote, redFlags: top.redFlags },
    });
    log(`  why fit:  ${narrative.whyFit}`);
    log(`  gap:      ${narrative.gap}`);
    if (narrative.redFlags.length) log(`  red flags: ${narrative.redFlags.join("; ")}`);

    // ── 7. prep: evidence-grounded resume tailoring + an answer ──
    hr();
    log(`\x1b[1m  TAILORING\x1b[0m  (evidence-grounded, honest-voice) — top match`);
    hr();
    const variants = await tailorResume(llm, profile, evidence, top.posting);
    log(`  ATS keyword coverage: ${(variants.atsKeywordCoverage * 100).toFixed(0)}%` +
        (variants.missingKeywords.length ? ` · surface: ${variants.missingKeywords.slice(0, 5).join(", ")}` : ""));
    log(`  yc/startup bullets:`);
    variants.yc_startup.slice(0, 3).forEach((b) => log(`    • ${b}`));
    const ans = await answerQuestion(llm, profile, evidence, top.posting, "Why do you want to work here?");
    log(`  answer ("Why here?"): ${ans.slice(0, 200)}…`);

    // ── 8. autofill DRY RUN (never submits, §7.1) ──
    hr();
    log(`\x1b[1m  AUTOFILL — DRY RUN\x1b[0m  (flag-guarded; never submits)`);
    hr();
    const applicant: ApplicantData = {
      firstName: "Jagrit",
      lastName: "—",
      email: "jagritvats6@gmail.com",
      github: "github.com/jagritvats",
      linkedin: "linkedin.com/in/jagritvats",
      resumePath: "~/resumes/tailored.pdf",
      answers: { "why do you want to work here": ans },
    };
    const atsType = top.posting.atsType === "unknown" ? "greenhouse" : top.posting.atsType;
    const plan = buildFillPlan(atsType, top.posting.applyUrl ?? "(no apply url)", applicant);
    log(renderDryRun(plan).split("\n").map((l) => `  ${l}`).join("\n"));
  }
  log("");
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
