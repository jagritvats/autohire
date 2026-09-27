import type { Company, Posting } from "@jobflow/core";
import { getAdapter } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";

export interface LivenessOptions {
  tenantId: string;
  /** how many of the tenant's top cards to re-check (default 40). */
  limit?: number;
  log?: (m: string) => void;
}

export interface LivenessStats {
  checked: number;
  /** confirmed still listed → re-verified (lastSeen bumped) */
  live: number;
  /** confirmed gone by the source → retired now */
  retired: number;
  /** the probe couldn't tell (error / rate limit) → left alone */
  unknown: number;
  /** no per-job probe for the source (Hirist renders the same page either way, …) */
  unsupported: number;
}

/**
 * Dead-link check between polls (§3). Boards are re-polled every few hours to days and
 * feed postings only expire after FEED_TTL_DAYS, so a filled role can sit at the top of
 * the feed for days. This re-probes the tenant's top cards on their source's own per-job
 * endpoint: a DEFINITIVE "gone" (per-job 404/410, the board's closed/expired flag)
 * retires the posting now; "still there" re-verifies it; anything else changes nothing
 * — an error is never read as a closure (invariant #5). Cloud-safe: probes come from the
 * cloud registry only (invariant #1). One probe in flight per source, sources in parallel.
 */
export async function checkLiveness(repo: Repository, opts: LivenessOptions): Promise<LivenessStats> {
  const log = opts.log ?? (() => {});
  const stats: LivenessStats = { checked: 0, live: 0, retired: 0, unknown: 0, unsupported: 0 };
  const top = (await repo.listMatches(opts.tenantId, opts.limit ?? 40)).map((m) => m.posting);

  const bySource = new Map<string, Posting[]>();
  for (const p of top) bySource.set(p.source, [...(bySource.get(p.source) ?? []), p]);

  const companies = new Map<string, Company | null>();
  const gone: string[] = [];
  await Promise.all(
    [...bySource].map(async ([source, postings]) => {
      const adapter = getAdapter(source as Posting["source"]);
      if (!adapter?.isLive || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) {
        stats.unsupported += postings.length;
        return;
      }
      for (const p of postings) {
        if (!companies.has(p.companyId)) companies.set(p.companyId, await repo.getCompany(p.companyId));
        const company = companies.get(p.companyId);
        const prefix = `${p.source}:`;
        const live = await adapter
          .isLive({
            slug: p.atsType !== "unknown" ? (company?.atsSlug ?? null) : null,
            jobId: p.atsJobId.startsWith(prefix) ? p.atsJobId.slice(prefix.length) : p.atsJobId,
            applyUrl: p.applyUrl,
          })
          .catch(() => null);
        stats.checked++;
        if (live === true) {
          await repo.touchSeen(p.companyId, [p.atsJobId]);
          stats.live++;
        } else if (live === false) {
          gone.push(p.id);
          log(`  gone: ${p.companyName} — ${p.title} (${source})`);
        } else {
          stats.unknown++;
        }
      }
    }),
  );
  stats.retired = await repo.retirePostings(gone);
  return stats;
}
