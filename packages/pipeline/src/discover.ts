import { classifyLink, isIndiaWorkable, normCompany, parseLocation, type AtsType } from "@jobflow/core";
import { atsAdapter, detect, type DetectResult } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { DEFAULT_POLL_COUNTRY } from "./ingest.js";

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

    const det = await detectChecked({ url: seed.careersUrl, name: seed.name });
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

/** Tag on a company shell whose name-based detection already failed (don't re-probe). */
export const DETECT_TRIED_TAG = "detect:tried";

export interface ResolveStats {
  tried: number;
  resolved: string[];
}

/**
 * Close the discovery loop (§ discovery routing). Aggregator/HN postings only create
 * company SHELLS (name, no board), and nothing upgraded them — so those companies were
 * never polled at the rich, fresh ATS source. Resolve a bounded batch per run.
 *
 * Only shells with at least one India-workable posting are worth probing: discovery
 * feeds are US-heavy, and resolving every shell would just import more US-only boards.
 * A failed attempt is tagged so the same name isn't re-probed every poll.
 */
export async function resolveDiscoveredCompanies(
  repo: Repository,
  opts: { max?: number } = {},
): Promise<ResolveStats> {
  const max = opts.max ?? 10;
  const stats: ResolveStats = { tried: 0, resolved: [] };
  const shells = (await repo.listCompanies({ status: "active" })).filter(
    (c) => c.atsType === "unknown" && !c.tags.includes(DETECT_TRIED_TAG),
  );

  for (const c of shells) {
    if (stats.tried >= max) break;
    const postings = await repo.listPostingsByCompany(c.id);
    if (!postings.some((p) => isIndiaWorkable(p.location))) continue;
    stats.tried++;
    // a posting that applies on the employer's own ATS / careers page is the strongest
    // pointer (TimesJobs, Reddit, Instahyre often link there) — far better than a name guess
    const applyLink = bestApplyLink(postings.map((p) => p.applyUrl));
    const viaLink = applyLink ? await detect({ url: applyLink }).catch(() => null) : null;
    const det =
      viaLink && viaLink.atsType !== "unknown" && viaLink.confidence === "confirmed"
        ? viaLink
        : await detectChecked({ url: c.careersUrl, name: c.name });
    if (det && det.atsType !== "unknown" && det.confidence === "confirmed") {
      await repo.upsertCompany({
        name: c.name,
        nameNorm: c.nameNorm,
        atsType: det.atsType,
        atsSlug: det.atsSlug,
        tags: ["resolved"],
      });
      stats.resolved.push(`${c.name} → ${det.atsType}/${det.atsSlug}`);
    } else {
      await repo.updateCompany(c.id, { tags: [...c.tags, DETECT_TRIED_TAG] });
    }
  }
  return stats;
}

/** a name-guessed board must list an India-workable role posted within this window. */
const GUESS_FRESH_DAYS = 120;

/**
 * Detect a board; when only the NAME was available, verify the guess. Slug-from-name
 * probing confirms that SOME board exists at that slug, not that it is this company:
 * Greenhouse "porter" is a cafe, Lever "fi" a US firm, Greenhouse "linkedin" a test
 * account. Accept a guessed board only if it lists a recent India-workable role, the
 * reason the company was worth resolving. An explicit careers URL is trusted as-is.
 */
export async function detectChecked(input: { url?: string | null; name: string }): Promise<DetectResult | null> {
  const det = await detect(input).catch(() => null);
  if (!det || det.atsType === "unknown" || !det.atsSlug) return det;
  if (input.url) return det;
  return (await plausibleIndiaBoard(det.atsType, det.atsSlug)) ? det : null;
}

async function plausibleIndiaBoard(ats: AtsType, slug: string): Promise<boolean> {
  const adapter = atsAdapter(ats);
  if (!adapter) return false;
  const raws = await adapter.fetch({ slug, location: DEFAULT_POLL_COUNTRY, limit: 1 }).catch(() => []);
  const cutoff = Date.now() - GUESS_FRESH_DAYS * 86_400_000;
  return raws.some(
    (r) =>
      isIndiaWorkable(parseLocation(r.locationRaw)) &&
      (!r.postedAt || new Date(r.postedAt as string | Date).getTime() > cutoff),
  );
}

/** An ATS link beats a careers-page link; board/aggregator links are no help. */
function bestApplyLink(urls: Array<string | null>): string | null {
  const links = urls.filter((u): u is string => !!u).map(classifyLink);
  return links.find((l) => l.kind === "ats")?.url ?? links.find((l) => l.kind === "careers")?.url ?? null;
}
