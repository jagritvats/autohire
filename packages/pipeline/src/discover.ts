import { classifyLink, isWorkableIn, normCompany, parseLocation, type AtsType } from "@jobflow/core";
import { atsAdapter, detect, type DetectResult } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { defaultPollCountry } from "./ingest.js";

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
  opts: {
    /** ISO-2 markets a name-guessed board must have a workable role in (default ["IN"]). */
    markets?: string[];
    /** detections in flight at once (default 8; at most 2 per host — politeness). */
    concurrency?: number;
  } = {},
): Promise<DiscoverStats> {
  const stats: DiscoverStats = { seeded: 0, resolved: 0, unresolved: [] };
  const markets = opts.markets?.length ? opts.markets : undefined;

  // independent per seed; ~230 seeds in series took minutes, so detections run pooled
  // (keyed by the careers host — or one "probe" lane for names-only guesses, which all hit
  // the same few ATS APIs — so no single host sees more than 2 at once)
  await mapPoolKeyed(seeds, { concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY, perKey: 2, key: seedHostKey }, async (seed) => {
    const nameNorm = normCompany(seed.name);
    const existing = await repo.findCompanyByNameNorm(nameNorm);

    // skip detection if we already have a confirmed slug
    if (existing?.atsSlug && existing.atsType !== "unknown") {
      stats.seeded++;
      return;
    }

    const det = await detectChecked({ url: seed.careersUrl, name: seed.name }, markets);
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
  });

  return stats;
}

/** default in-flight limit for discovery / board polling pools. */
export const DEFAULT_CONCURRENCY = 8;

function seedHostKey(seed: SeedCompany): string {
  if (!seed.careersUrl) return "probe";
  try {
    return new URL(seed.careersUrl).hostname;
  } catch {
    return "probe";
  }
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight overall and at most `perKey`
 * per key (a host) — parallel across hosts, still polite to each one. Results keep input
 * order; an item's rejection propagates (callers handle their own errors).
 */
export async function mapPoolKeyed<T, R>(
  items: readonly T[],
  opts: { concurrency: number; perKey: number; key: (item: T) => string },
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const pending = items.map((item, i) => ({ item, i, key: opts.key(item) }));
  const active = new Map<string, number>();
  const limit = Math.max(1, opts.concurrency);
  const perKey = Math.max(1, opts.perKey);
  let running = 0;
  return new Promise<R[]>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (!pending.length && running === 0) return resolve(out);
      for (let j = 0; j < pending.length && running < limit; ) {
        const next = pending[j]!;
        if ((active.get(next.key) ?? 0) >= perKey) {
          j++;
          continue;
        }
        pending.splice(j, 1);
        running++;
        active.set(next.key, (active.get(next.key) ?? 0) + 1);
        fn(next.item, next.i).then(
          (r) => {
            out[next.i] = r;
            running--;
            active.set(next.key, (active.get(next.key) ?? 1) - 1);
            pump();
          },
          (e) => {
            failed = true;
            reject(e);
          },
        );
      }
    };
    pump();
  });
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
  opts: {
    max?: number;
    /** ISO-2 markets a shell must have a workable posting in (default ["IN"]). */
    markets?: string[];
  } = {},
): Promise<ResolveStats> {
  const max = opts.max ?? 10;
  const given = opts.markets?.length ? opts.markets : undefined;
  const markets = given ?? ["IN"];
  const stats: ResolveStats = { tried: 0, resolved: [] };
  const shells = (await repo.listCompanies({ status: "active" })).filter(
    (c) => c.atsType === "unknown" && !c.tags.includes(DETECT_TRIED_TAG),
  );

  for (const c of shells) {
    if (stats.tried >= max) break;
    const postings = await repo.listPostingsByCompany(c.id);
    if (!postings.some((p) => isWorkableIn(p.location, markets))) continue;
    stats.tried++;
    // a posting that applies on the employer's own ATS / careers page is the strongest
    // pointer (TimesJobs, Reddit, Instahyre often link there) — far better than a name guess
    const applyLink = bestApplyLink(postings.map((p) => p.applyUrl));
    const viaLink = applyLink ? await detect({ url: applyLink }).catch(() => null) : null;
    const det =
      viaLink && viaLink.atsType !== "unknown" && viaLink.confidence === "confirmed"
        ? viaLink
        : await detectChecked({ url: c.careersUrl, name: c.name }, given);
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

/** a name-guessed board must list a workable role posted within this window. */
const GUESS_FRESH_DAYS = 120;

/**
 * Detect a board; when only the NAME was available, verify the guess. Slug-from-name
 * probing confirms that SOME board exists at that slug, not that it is this company:
 * Greenhouse "porter" is a cafe, Lever "fi" a US firm, Greenhouse "linkedin" a test
 * account. Accept a guessed board only if it lists a recent role workable in one of the
 * `markets` (default India), the reason the company was worth resolving. An explicit
 * careers URL is trusted as-is.
 */
export async function detectChecked(
  input: { url?: string | null; name: string },
  markets?: string[],
): Promise<DetectResult | null> {
  const det = await detect(input).catch(() => null);
  if (!det || det.atsType === "unknown" || !det.atsSlug) return det;
  if (input.url) return det;
  return (await plausibleBoard(det.atsType, det.atsSlug, markets)) ? det : null;
}

/**
 * A guessed board lists a recent role workable in one of `markets`, fetched for the first
 * market. No markets → today's behaviour: India-workable, fetched for the poll country.
 */
export async function plausibleBoard(ats: AtsType, slug: string, markets?: string[]): Promise<boolean> {
  const adapter = atsAdapter(ats);
  if (!adapter) return false;
  const want = markets?.length ? markets : ["IN"];
  const location = markets?.length ? markets[0] : defaultPollCountry();
  const raws = await adapter.fetch({ slug, location, limit: 1 }).catch(() => []);
  const cutoff = Date.now() - GUESS_FRESH_DAYS * 86_400_000;
  return raws.some(
    (r) =>
      isWorkableIn(parseLocation(r.locationRaw), want) &&
      (!r.postedAt || new Date(r.postedAt as string | Date).getTime() > cutoff),
  );
}

/** India wrapper (kept for callers): `plausibleBoard` with today's defaults. */
export async function plausibleIndiaBoard(ats: AtsType, slug: string): Promise<boolean> {
  return plausibleBoard(ats, slug);
}

/** An ATS link beats a careers-page link; board/aggregator links are no help. */
function bestApplyLink(urls: Array<string | null>): string | null {
  const links = urls.filter((u): u is string => !!u).map(classifyLink);
  return links.find((l) => l.kind === "ats")?.url ?? links.find((l) => l.kind === "careers")?.url ?? null;
}
