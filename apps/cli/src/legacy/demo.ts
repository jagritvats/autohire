import { InMemoryRepository } from "@jobflow/db";
import {
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
  DEFAULT_DISCOVERY_FEEDS,
  DEFAULT_TENANT,
  SEED_COMPANIES,
  sampleProfile,
  sampleEvidence,
} from "@jobflow/pipeline";
import { atsAdapter, getAdapter } from "@jobflow/adapters";
import { createProvider, rerankMatch, tailorResume, answerQuestion } from "@jobflow/llm";
import { buildFillPlan, renderDryRun, resolveApplyUrl, type ApplicantData } from "@jobflow/autofill";
import { renderMatchCard } from "../render/match-card.js";

/**
 * `jobflow demo` — runs the real pipeline against the live free APIs with a throwaway
 * in-memory repo and the FICTIONAL sample candidate (never touches your data dir).
 * Exercises the whole spine: discover → poll ATS → normalize → dedup → rank → match cards.
 */

const log = (...a: unknown[]) => console.log(...a);
const hr = () => log("─".repeat(78));

export async function demo(): Promise<void> {
  const repo = new InMemoryRepository();
  // the demo runs as the FICTIONAL sample candidate — never a real person's data
  const profile = sampleProfile();
  await repo.saveProfile(profile);
  for (const e of sampleEvidence()) await repo.saveEvidence(e);

  log("\n\x1b[1mJobFlow demo\x1b[0m — live pipeline on free APIs, in-memory store\n");

  // The demo is a quick end-to-end check, not a full crawl: a diverse sample of seeds,
  // a capped number of boards, one target per feed, all through a small concurrency
  // pool — so it finishes in a couple of minutes. The worker does the full sweep.
  const started = Date.now();

  // ── 1. discover: seed registry + resolve ATS slugs (sample) ──
  const seeds = diverseSample(
    SEED_COMPANIES.filter((s) => !!s.careersUrl),
    DEMO_SEEDS,
    (s) => hostFamily(s.careersUrl!),
  );
  log(`① Discovery — resolving ATS boards for ${seeds.length} of ${SEED_COMPANIES.length} seeds…`);
  const discChunks = await pool(chunk(seeds, Math.ceil(seeds.length / DEMO_CONCURRENCY)), DEMO_CONCURRENCY, (c) =>
    discoverCompanies(repo, c),
  );
  const resolvedN = discChunks.reduce((n, d) => n + d.resolved, 0);
  const unresolved = discChunks.flatMap((d) => d.unresolved);
  log(`   seeded ${seeds.length}, resolved ${resolvedN} via ATS Detector` +
      (unresolved.length ? `, unresolved: ${unresolved.slice(0, 8).join(", ")}${unresolved.length > 8 ? ", …" : ""}` : ""));

  // ── 2. poll a diverse sample of the resolved boards (cloud adapters only) ──
  const resolved = (await repo.listCompanies({ status: "active" })).filter(
    (c) => c.atsType !== "unknown" && !!c.atsSlug && !!atsAdapter(c.atsType),
  );
  const boards = diverseSample(resolved, DEMO_BOARDS, (c) => c.atsType);
  log(`\n② Ingestion — polling ${boards.length} of ${resolved.length} resolved ATS boards (${DEMO_CONCURRENCY} at a time)…`);
  let totalFetched = 0;
  await pool(boards, DEMO_CONCURRENCY, async (c) => {
    const s = await ingestCompany(repo, c, { limit: 60 }).catch(() => null);
    totalFetched += s?.fetched ?? 0;
    if (s?.fetched) log(`   ${c.name.padEnd(16)} ${c.atsType.padEnd(10)} ${s.fetched} postings`);
  });

  // ── 3. discovery via aggregators + HN (one target per feed, slow feeds skipped) ──
  log("\n③ Discovery feeds — the same cloud-safe feeds the worker polls (first target each)…");
  const feeds = DEFAULT_DISCOVERY_FEEDS.filter((f) => !f.slow && !!getAdapter(f.source) && !!f.targets[0]);
  await pool(feeds, DEMO_CONCURRENCY, async (feed) => {
    const n = (await ingestFromAdapter(repo, getAdapter(feed.source)!, feed.targets[0]!).catch(() => null))?.fetched ?? 0;
    log(`   ${feed.source.padEnd(16)} ${n} postings`);
    totalFetched += n;
  });
  log(`   (ingestion took ${Math.round((Date.now() - started) / 1000)}s)`);

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
    // a real model's failure surfaces as an error (never a silent template) — log it and go on
    const variants = await tailorResume(llm, profile, evidence, top.posting).catch((e: Error & { userMessage?: string }) => {
      log(`  tailoring failed: ${e.userMessage ?? e.message}`);
      return null;
    });
    if (variants) {
      log(`  ATS keyword coverage: ${(variants.atsKeywordCoverage * 100).toFixed(0)}%` +
          (variants.missingKeywords.length ? ` · surface: ${variants.missingKeywords.slice(0, 5).join(", ")}` : ""));
      log(`  yc/startup bullets:`);
      variants.yc_startup.slice(0, 3).forEach((b) => log(`    • ${b}`));
    }
    const ans = await answerQuestion(llm, profile, evidence, top.posting, "Why do you want to work here?");
    log(`  answer ("Why here?"): ${ans.slice(0, 200)}…`);

    // ── 8. autofill DRY RUN (never submits, §7.1) ──
    hr();
    log(`\x1b[1m  AUTOFILL — DRY RUN\x1b[0m  (flag-guarded; never submits)`);
    hr();
    const c = profile.prefs.contact;
    const applicant: ApplicantData = {
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      github: c.github,
      linkedin: c.linkedin,
      resumePath: "~/resumes/tailored.pdf",
      answers: { "why do you want to work here": ans },
    };
    // unknown/aggregator postings get the generic field map; Greenhouse opens its hosted form
    const company = await repo.getCompany(top.posting.companyId);
    const url = resolveApplyUrl(top.posting.atsType, top.posting.applyUrl, { slug: company?.atsSlug, jobId: top.posting.atsJobId });
    const plan = buildFillPlan(top.posting.atsType, url ?? "(no apply url)", applicant);
    log(renderDryRun(plan).split("\n").map((l) => `  ${l}`).join("\n"));
  }
  log("");
}

/** demo bounds: seeds to resolve, boards to poll, parallel requests */
const DEMO_SEEDS = 40;
const DEMO_BOARDS = 25;
const DEMO_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** Up to `n` items, round-robin across groups (keeps each group's order) — a sample that
 *  covers every ATS family instead of the first N of whichever dominates the list. */
function diverseSample<T>(items: T[], n: number, key: (t: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  while (out.length < n && queues.some((q) => q.length)) {
    for (const q of queues) {
      const it = q.shift();
      if (it !== undefined && out.length < n) out.push(it);
    }
  }
  return out;
}

/** "boards.greenhouse.io" → "greenhouse.io", "acme.wd5.myworkdayjobs.com" → "myworkdayjobs.com" */
function hostFamily(url: string): string {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "other";
  }
}
