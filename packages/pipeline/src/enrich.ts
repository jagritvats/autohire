import type { Posting, SalaryBand } from "@jobflow/core";
import {
  fetchLevelsComp,
  familyMedianFor,
  fetchAdzunaSalary,
  hasAdzunaKeys,
  slugFromName,
  type LevelsComp,
} from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";

/**
 * Tier-1 enrichment cascade (§11.4). GATED ON MATCH SCORE — enrichment is
 * rate-limited and only worth it for roles you'd act on, so we enrich the top-N
 * matched companies/postings, not the whole corpus. Cloud-safe (no Tier-3).
 *
 * Per company: levels.fyi comp benchmark (median + family breakdown), cached ~30d.
 * Per posting lacking direct comp: estimate via Adzuna (country-aware, preferred)
 * → else the company's levels.fyi family median, cached by (archetype, country).
 */

export interface EnrichStats {
  companiesEnriched: number;
  postingsEstimated: number;
  adzunaUsed: boolean;
}

export async function enrichTopMatches(
  repo: Repository,
  opts: { tenantId: string; limit?: number; staleDays?: number } = { tenantId: "" },
): Promise<EnrichStats> {
  const limit = opts.limit ?? 40;
  const staleDays = opts.staleDays ?? 30;
  const stats: EnrichStats = { companiesEnriched: 0, postingsEstimated: 0, adzunaUsed: hasAdzunaKeys() };

  const matches = await repo.listMatches(opts.tenantId, limit);
  const seenCompanies = new Set<string>();
  const levelsByCompany = new Map<string, LevelsComp | null>();

  for (const m of matches) {
    const posting = m.posting;
    // ── company comp benchmark (once per company, cached) ──
    if (!seenCompanies.has(posting.companyId)) {
      seenCompanies.add(posting.companyId);
      const company = await repo.getCompany(posting.companyId);
      const fresh = company?.enrichedAt && daysSince(company.enrichedAt) < staleDays;
      let levels: LevelsComp | null = null;
      if (fresh && company?.compBreakdown) {
        // reuse cached benchmark for posting estimates without re-fetch
        levels = {
          slug: "", currency: company.compCurrency ?? "USD", scopeLocation: "United States",
          medianAll: company.compMedian, families: company.compBreakdown, source: "levelsfyi",
          attribution: "Data source: Levels.fyi (https://www.levels.fyi)",
        };
      } else {
        levels = await fetchLevelsComp(slugFromName(posting.companyName));
        if (levels) {
          await repo.saveCompanyEnrichment(posting.companyId, {
            compMedian: levels.medianAll,
            compCurrency: levels.currency,
            compSource: "levelsfyi",
            compBreakdown: levels.families.slice(0, 12),
          });
          stats.companiesEnriched++;
        } else if (company && !company.enrichedAt) {
          // mark attempted so we don't refetch a miss every run
          await repo.saveCompanyEnrichment(posting.companyId, { compSource: "none" });
        }
      }
      levelsByCompany.set(posting.companyId, levels);
    }

    // ── posting-level estimate (only if no direct/high-confidence comp) ──
    if (hasUsableSalary(posting)) continue;
    const band = await estimateSalary(repo, posting, levelsByCompany.get(posting.companyId) ?? null);
    if (band) {
      await repo.updatePostingSalary(posting.id, band);
      stats.postingsEstimated++;
    }
  }

  return stats;
}

function hasUsableSalary(p: Posting): boolean {
  return p.salary.source !== "none" && (p.salary.min != null || p.salary.max != null);
}

async function estimateSalary(
  repo: Repository,
  posting: Posting,
  levels: LevelsComp | null,
): Promise<SalaryBand | null> {
  const loc = [posting.location.city, posting.location.country].filter(Boolean).join(", ") || posting.location.country || "";
  const cacheKey = `adz:${posting.roleArchetype}:${posting.location.country ?? "unknown"}`;

  // 1. Adzuna (country-aware) — preferred; cache by (archetype, country)
  if (hasAdzunaKeys() && loc) {
    const cached = await repo.getSalaryCache(cacheKey);
    if (cached && cached.estMin != null) {
      return { min: cached.estMin, max: cached.estMax, currency: cached.currency, source: "adzuna_cache", confidence: "medium" };
    }
    const adz = await fetchAdzunaSalary(posting.roleArchetype, loc);
    if (adz) {
      await repo.putSalaryCache({
        key: cacheKey, roleArchetype: posting.roleArchetype, location: posting.location.country,
        estMin: adz.min, estMax: adz.max, currency: adz.currency, source: "adzuna", confidence: "medium", ttlDays: 14,
      });
      return { min: adz.min, max: adz.max, currency: adz.currency, source: "adzuna", confidence: "medium" };
    }
  }

  // 2. levels.fyi family median (US comp). Honest confidence: medium if the role is
  //    US-located, low otherwise (US comp is a weak proxy for India/EU).
  if (levels) {
    const median = familyMedianFor(levels, posting.roleArchetype);
    if (median != null) {
      const usLocated = posting.location.country == null || /united states|us/i.test(posting.location.country);
      return {
        min: Math.round(median * 0.85),
        max: Math.round(median * 1.15),
        currency: levels.currency,
        source: "levelsfyi",
        confidence: usLocated ? "medium" : "low",
      };
    }
  }
  return null;
}

function daysSince(t: string | Date): number {
  return (Date.now() - new Date(t as string).getTime()) / 86_400_000;
}
