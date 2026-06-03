import { normCompany } from "@jobflow/core";
import { detect } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";

export interface SeedCompany {
  name: string;
  careersUrl?: string;
  tags?: string[];
  pollCadence?: "daily" | "weekly" | "manual";
}

export interface DiscoverStats {
  seeded: number;
  resolved: number;
  unresolved: string[];
}

/**
 * Grow the Company Registry from a seed list / discovered names. For each, run the
 * ATS Detector to resolve a board slug, so the poll loop can hit the rich source
 * directly (§ discovery routing). Polite: detection probes are bounded per name.
 */
export async function discoverCompanies(
  repo: Repository,
  seeds: SeedCompany[],
): Promise<DiscoverStats> {
  const stats: DiscoverStats = { seeded: 0, resolved: 0, unresolved: [] };

  for (const seed of seeds) {
    const nameNorm = normCompany(seed.name);
    const existing = await repo.findCompanyByNameNorm(nameNorm);

    // skip detection if we already have a confirmed slug
    if (existing?.atsSlug && existing.atsType !== "unknown") {
      stats.seeded++;
      continue;
    }

    const det = await detect({ url: seed.careersUrl, name: seed.name }).catch(() => null);
    await repo.upsertCompany({
      name: seed.name,
      nameNorm,
      atsType: det?.atsType ?? "unknown",
      atsSlug: det?.atsSlug ?? null,
      careersUrl: seed.careersUrl ?? null,
      tags: seed.tags ?? [],
      pollCadence: seed.pollCadence ?? "weekly",
    });
    stats.seeded++;

    if (det && det.atsType !== "unknown" && det.confidence === "confirmed") stats.resolved++;
    else stats.unresolved.push(seed.name);
  }

  return stats;
}
