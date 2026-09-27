import { salaryMarketOf } from "@jobflow/core";
import { LEVELS_MARKET_SLUG, fetchLevelsComp, fetchLevelsCompanyMarket, slugFromName } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import {
  ensureSalaryCalibration,
  estimatePostingSalaries,
  levelsCompanyBenchmark,
  refreshSalaryBenchmarks,
  type EstimateStats,
} from "./salary.js";

/**
 * Tier-1 enrichment (§11.4). The NETWORK half is GATED ON MATCH SCORE — rate-limited
 * sources are only worth spending on roles you'd act on — so it runs for the top-N matches;
 * the estimate itself is offline and re-prices every posting. Cloud-safe (no Tier-3).
 *
 *   1. per top company: levels.fyi comp benchmark (median + family breakdown), and its
 *      level ladder in each market its top postings are in (company × country), ~30d
 *   2. market benchmarks: levels.fyi market×level pages, Adzuna role×level×country (keyed)
 *   3. recalibrate per-market confidence from a backtest when last week's has expired
 *   4. estimate every active posting that states no pay → `posting.salaryEstimate`
 *      (never written into `posting.salary`, which is only ever what the posting says)
 */

export interface EnrichStats {
  companiesEnriched: number;
  /** employer level ladders fetched (levels.fyi company × country) */
  companyLaddersFetched: number;
  levelsMarketFetched: number;
  adzunaFetched: number;
  adzunaUsed: boolean;
  postingsEstimated: number;
  estimate: EstimateStats;
}

export async function enrichTopMatches(
  repo: Repository,
  opts: { tenantId: string; limit?: number; staleDays?: number } = { tenantId: "" },
): Promise<EnrichStats> {
  const limit = opts.limit ?? 40;
  const staleDays = opts.staleDays ?? 30;
  let companiesEnriched = 0;
  let companyLaddersFetched = 0;

  const matches = await repo.listMatches(opts.tenantId, limit);
  // the pay markets each top company is hiring in (among its top matches)
  const marketsByCompany = new Map<string, Set<string>>();
  for (const m of matches) {
    const market = salaryMarketOf(m.posting.location);
    if (!market || !LEVELS_MARKET_SLUG[market]) continue;
    const set = marketsByCompany.get(m.posting.companyId) ?? new Set<string>();
    set.add(market);
    marketsByCompany.set(m.posting.companyId, set);
  }

  const seen = new Set<string>();
  for (const m of matches) {
    const posting = m.posting;
    if (seen.has(posting.companyId)) continue;
    seen.add(posting.companyId);
    const company = await repo.getCompany(posting.companyId);

    // the employer's own ladder in each market it's hiring in here (verified offers)
    for (const market of marketsByCompany.get(posting.companyId) ?? []) {
      const prior = company?.compBenchmarks?.find((b) => b.source === "levelsfyi" && b.market === market);
      if (prior && daysSince(prior.fetchedAt) < staleDays) continue;
      const lv = await fetchLevelsCompanyMarket(slugFromName(posting.companyName), market);
      await repo.saveCompanyEnrichment(posting.companyId, { compBenchmark: levelsCompanyBenchmark(lv, market) });
      if (lv) companyLaddersFetched++;
    }

    if (company?.enrichedAt && daysSince(company.enrichedAt) < staleDays) continue;
    const levels = await fetchLevelsComp(slugFromName(posting.companyName));
    if (levels) {
      await repo.saveCompanyEnrichment(posting.companyId, {
        compMedian: levels.medianAll,
        compCurrency: levels.currency,
        compSource: "levelsfyi",
        compBreakdown: levels.families.slice(0, 12),
      });
      companiesEnriched++;
    } else if (company && !company.enrichedAt) {
      // mark attempted so we don't refetch a miss every run
      await repo.saveCompanyEnrichment(posting.companyId, { compSource: "none" });
    }
  }

  const bench = await refreshSalaryBenchmarks(repo, { postings: matches.map((m) => m.posting) });
  await ensureSalaryCalibration(repo);
  const estimate = await estimatePostingSalaries(repo);
  return {
    companiesEnriched,
    companyLaddersFetched,
    levelsMarketFetched: bench.levelsFetched,
    adzunaFetched: bench.adzunaFetched,
    adzunaUsed: bench.adzunaEnabled,
    postingsEstimated: estimate.estimated,
    estimate,
  };
}

function daysSince(t: string | Date): number {
  return (Date.now() - new Date(t as string).getTime()) / 86_400_000;
}
