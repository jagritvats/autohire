import { AtsType, SourceKind, normCompany, type Company, type SyncPhaseId } from "@jobflow/core";
import { atsAdapter, atsLinksFromRaws, fetchTelegramChannel, getAdapter, takeFeedError } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";
import { ingestCompany, ingestFromAdapter } from "./ingest.js";
import { DEFAULT_CONCURRENCY, discoverCompanies, mapPoolKeyed, resolveDiscoveredCompanies, type SeedCompany } from "./discover.js";
import { harvestLinks } from "./harvest.js";
import { localEmbedder, type Embedder } from "./embedder.js";
import { estimatePostingSalaries, reparseSalariesIfStale } from "./salary.js";
import { fxRefreshEnabled, loadFxRates, refreshFxRates } from "./fx.js";
import { renormalizeIfStale, renormalizeSummary, type RenormalizeRun } from "./renormalize.js";
import { resolveDiscoveryPlan, type CustomSourceTarget, type DiscoveryPlan, type SearchTarget } from "./discovery.js";
import type { DiscoveryFeed } from "./presets/types.js";
import { emitter, type PollListener } from "./progress.js";

// The feed/channel lists now live in the `india` preset (presets/india.ts) — re-exported
// here so existing importers keep working.
export type { DiscoveryFeed } from "./presets/types.js";
export { DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "./presets/india.js";

/**
 * Postings from non-board sources (aggregators, HN) have no per-company board to diff,
 * so `markStale` can't retire them. Anything not re-seen by its feed in this window is
 * soft-deleted (§3). Board postings are covered by markStale on every poll.
 */
export const FEED_TTL_DAYS = 14;

/**
 * A board posting unseen this long, on a board fetched since, is gone (board emptied — an
 * empty fetch never mass-stales, since it can't be told from an error — or a partial list
 * that no longer carries it). Paused/removed companies' postings go after it too. A board
 * the per-run cap hasn't reached yet is never swept (`expireUnseenBoardPostings`).
 */
export const BOARD_TTL_DAYS = 21;

/** every source that is not a company ATS board — incl. ones no longer in the feed list. */
export const NON_BOARD_SOURCES: SourceKind[] = SourceKind.options.filter(
  (s) => !(AtsType.options as readonly string[]).includes(s),
);

export interface PollOptions {
  embedder?: Embedder;
  /** poll just this company (skips discovery feeds, resolution and the TTL sweep). */
  companyId?: string;
  /**
   * ISO country for boards that filter server-side. Default: the discovery plan's
   * `pollCountries` (JOBFLOW_POLL_COUNTRY → tenants' markets → preset markets → IN); a
   * multi-market plan polls country-filtered boards once per country.
   */
  country?: string;
  /** cap upserts per board (embedding cost); the fetch is always the full board. */
  limitPerCompany?: number;
  /** poll every active company, not just those due by cadence. */
  allCompanies?: boolean;
  /**
   * max boards this run, most overdue first. Default `JOBFLOW_SYNC_MAX_BOARDS`, else
   * "auto": every DUE board (daily boards every ~day, weekly ones once a week, never-polled
   * ones now), so the per-run budget scales with the registry and its cadences instead of a
   * fixed count that left a 240-board registry re-polled only every 5–10 days (audit
   * 2026-11). "auto" keeps a fresh registry's very FIRST sync quick (`FIRST_SYNC_MAX_BOARDS`
   * boards, `FIRST_SYNC_TIME_MS`); the rest follows on the next runs. `Infinity` = no cap.
   */
  maxBoards?: number | "auto";
  /**
   * stop STARTING board fetches after this long (in-flight ones finish). Boards it didn't
   * reach stay due and lead the next run, so an oversized backlog spreads over runs instead
   * of one long burst. Default `JOBFLOW_SYNC_MINUTES`, else `DEFAULT_SYNC_TIME_BUDGET_MS`;
   * `Infinity` = none.
   */
  timeBudgetMs?: number;
  /** discovery feeds to run. Default: the plan's (the tenants' presets — `india` by default). */
  feeds?: DiscoveryFeed[];
  /** max discovered company shells to resolve to ATS boards this run. */
  resolveMax?: number;
  /**
   * public Telegram channels to harvest for ATS/careers links (discovery only — see
   * harvest.ts). Default: JOBFLOW_TELEGRAM_CHANNELS when set (empty = off), else the plan's
   * (preset channels + custom Telegram sources).
   */
  telegramChannels?: string[];
  /** skip feeds marked `slow` (a request-bound web refresh can't wait a minute per call). */
  skipSlowFeeds?: boolean;
  /** a precomputed plan (else resolved from the repo). */
  plan?: DiscoveryPlan;
  /** run custom RSS/JSON/HN-thread sources (default true). */
  customSources?: boolean;
  /** run due saved searches against search-capable sources (default true). */
  searches?: boolean;
  /**
   * register plan seed employers that aren't in the registry yet — a newly chosen preset,
   * a custom company list (default true). Known companies are never re-probed here.
   */
  discoverNewSeeds?: boolean;
  /** boards polled at once (default 8; ≤2 per host — politeness). */
  concurrency?: number;
  /**
   * refresh FX rates from the public ECB feed (cached a day in the store; never required).
   * Default on, unless `JOBFLOW_FX_REFRESH=0` (tests never touch the network).
   */
  refreshFx?: boolean;
  log?: (m: string) => void;
  /** structured progress (service `sync-progress.ts` folds these into the one SyncProgress model) */
  onProgress?: PollListener;
  /**
   * cancel: stop STARTING boards/feeds; in-flight fetches finish and are stored, but no board
   * is diffed (markStale) and no sweep runs from a cancelled run (invariant #5).
   */
  signal?: AbortSignal;
}

export interface PollStats {
  companiesPolled: number;
  fetched: number;
  staled: number;
  feeds: Record<string, number>;
  resolved: string[];
  expired: number;
  /** postings fetched per custom source configKey */
  custom?: Record<string, number>;
  /** postings fetched per saved search id */
  searches?: Record<string, number>;
  /** postings (re)priced by the offline salary estimator after the poll (§11.4) */
  salaryEstimated?: number;
  /** cloud-pollable boards due at the start of this run */
  boardsDue?: number;
  /** due boards this run left for the next one (board cap or time budget reached) */
  boardsDeferred?: number;
  /** the run was cancelled (`signal`) before it finished */
  cancelled?: boolean;
  /** stored postings re-derived because the store's NORMALIZE_VERSION was older (once per version) */
  renormalized?: RenormalizeRun;
  /** stated salaries re-parsed because the store's SALARY_PARSE_VERSION was older (once per version) */
  salaryReparsed?: number;
  /** date of the FX rates comparisons now use, and whether this run fetched them */
  fx?: { asOf: string; status: "fetched" | "cached" | "static" };
  errors: string[];
}

/**
 * The single poll routine shared by the cron, the job runner and the web refresh:
 * boards due → discovery feeds → custom sources → saved searches → community links →
 * resolve relevant shells → expire postings nobody has re-confirmed. CLOUD-SAFE ONLY
 * (invariant #1): every source resolves through the cloud registry (`getAdapter` /
 * the plan's `cloudAdapter`), which never contains a Tier-3 adapter, and the tier is
 * re-checked.
 */
export async function pollAll(repo: Repository, opts: PollOptions = {}): Promise<PollStats> {
  const emit = emitter(opts.onProgress);
  // stored postings derived by an older parser are re-derived once, before this poll's
  // upserts, so the ranking every caller runs next sees one consistent corpus (§11.3).
  // A no-op (one meta read) when the store is current; never fails the poll. Progress shows
  // it as its own step only when it actually ran ("Re-check stored jobs").
  let renormalized: RenormalizeRun | null = null;
  let renormalizeError: string | null = null;
  emit({ type: "phase", phase: "renormalize", state: "start" });
  try {
    renormalized = await renormalizeIfStale(repo);
    if (renormalized?.changed) opts.log?.(`  re-normalized stored postings (v${renormalized.fromVersion ?? 0} → v${renormalized.toVersion}): ${renormalizeSummary(renormalized)}`);
  } catch (e) {
    renormalizeError = `renormalize: ${(e as Error).message}`;
    emit({ type: "error", source: "re-checking stored jobs", message: (e as Error).message });
  }
  emit({ type: "phase", phase: "renormalize", state: renormalized ? "done" : "skipped" });
  const stats = await pollSources(repo, opts, emit);
  if (renormalized) stats.renormalized = renormalized;
  if (renormalizeError) stats.errors.push(renormalizeError);
  // a cancelled run stops here: what it fetched is stored (idempotent upserts), nothing was
  // retired from a partial view (invariant #5), and the derived data catches up next run
  if (stats.cancelled) {
    emit({ type: "phase", phase: "fx", state: "skipped" });
    emit({ type: "phase", phase: "reparse", state: "skipped" });
    emit({ type: "phase", phase: "process", state: "skipped" });
    return stats;
  }
  // FX for every comparison the ranking runs next: the store's cached ECB table, refreshed
  // when a day old and reachable — else the newest we have (core's dated table). Never fails.
  // Progress shows it as a step only when this run actually fetched rates.
  try {
    const refresh = opts.refreshFx ?? fxRefreshEnabled();
    if (refresh) emit({ type: "phase", phase: "fx", state: "start" });
    const fx = refresh ? await refreshFxRates(repo) : { table: await loadFxRates(repo), status: "cached" as const };
    stats.fx = { asOf: fx.table.asOf, status: fx.status };
    emit({ type: "phase", phase: "fx", state: fx.status === "fetched" ? "done" : "skipped" });
  } catch (e) {
    stats.errors.push(`fx: ${(e as Error).message}`);
    emit({ type: "error", source: "exchange rates", message: (e as Error).message });
    emit({ type: "phase", phase: "fx", state: "skipped" });
  }
  // stated salaries parsed by an older extractor are re-parsed once (after renormalize: the
  // location prices a bare "$"), so a local install picks up a salary-parser fix on its next sync
  emit({ type: "phase", phase: "reparse", state: "start" });
  let reparsed = false;
  try {
    const re = await reparseSalariesIfStale(repo);
    if (re) {
      reparsed = true;
      stats.salaryReparsed = re.changed;
      if (re.changed) opts.log?.(`  re-parsed stated salaries (v${re.fromVersion ?? 0} → v${re.toVersion}): ${re.changed} of ${re.scanned} changed`);
    }
  } catch (e) {
    stats.errors.push(`salary reparse: ${(e as Error).message}`);
    emit({ type: "error", source: "re-reading pay", message: (e as Error).message });
  }
  emit({ type: "phase", phase: "reparse", state: reparsed ? "done" : "skipped" });
  // offline + cheap: re-price every posting that states no pay against the refreshed
  // corpus, so estimates track new comparables without waiting for an enrich run (§11.4).
  // Never fails the poll.
  emit({ type: "phase", phase: "process", state: "start" });
  try {
    stats.salaryEstimated = (await estimatePostingSalaries(repo)).estimated;
  } catch (e) {
    stats.errors.push(`salary estimate: ${(e as Error).message}`);
    emit({ type: "error", source: "pay estimates", message: (e as Error).message });
  }
  emit({ type: "phase", phase: "process", state: "done" });
  return stats;
}

async function pollSources(repo: Repository, opts: PollOptions, emit: PollListener): Promise<PollStats> {
  const embedder = opts.embedder ?? localEmbedder;
  const log = opts.log ?? (() => {});
  const signal = opts.signal;
  const stats: PollStats = { companiesPolled: 0, fetched: 0, staled: 0, feeds: {}, resolved: [], expired: 0, errors: [] };
  const skip = (...phases: SyncPhaseId[]) => phases.forEach((phase) => emit({ type: "phase", phase, state: "skipped" }));

  // what to poll: explicit options win; everything else comes from the tenants' plan
  let plan = opts.plan;
  if (!plan) {
    try {
      plan = await resolveDiscoveryPlan(repo);
    } catch (e) {
      stats.errors.push(`discovery plan: ${(e as Error).message}`);
      emit({ type: "error", source: "discovery plan", message: (e as Error).message });
    }
  }
  const countries = opts.country ? [opts.country] : (plan?.pollCountries ?? []);

  // 0. seed employers new to the registry (first run, a newly switched-on preset, a custom
  //    company list) are resolved to boards FIRST, so this same run polls them — otherwise a
  //    fresh install's first sync polls zero boards and only feeds
  if (plan && opts.discoverNewSeeds !== false && !opts.companyId && !signal?.aborted) {
    emit({ type: "phase", phase: "discover", state: "start" });
    const fresh: SeedCompany[] = [];
    for (const s of plan.seeds) {
      const c = await repo.findCompanyByNameNorm(normCompany(s.name));
      if (!c) fresh.push(s);
    }
    if (fresh.length) {
      try {
        const d = await discoverCompanies(repo, fresh, { markets: plan.pollCountries });
        log(`  seeds: ${fresh.length} new → ${d.resolved} boards`);
        if (d.resolved) emit({ type: "resolved", count: d.resolved });
      } catch (e) {
        stats.errors.push(`seed discovery: ${(e as Error).message}`);
        emit({ type: "error", source: "new companies", message: (e as Error).message });
      }
    }
    for (const id of plan.companyListSourceIds) {
      await repo.recordDiscoverySourceRun(id, { status: "ok", count: fresh.length }).catch(() => {});
    }
    emit({ type: "phase", phase: "discover", state: "done" });
  } else skip("discover");

  // 1. registered ATS boards (the rich, ghost-free spine) — pooled across hosts
  let companies: Company[];
  let deadline = Infinity;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  if (opts.companyId) {
    companies = (await repo.listCompanies()).filter((c) => c.id === opts.companyId);
    emit({ type: "plan", boards: companies.length, deferred: 0, notDue: 0, budgetMs: null, concurrency });
    emit({ type: "phase", phase: "boards", state: "start" });
  } else {
    const env = syncLimitsFromEnv();
    const pollable = (await repo.listCompanies({ status: "active" })).filter(isCloudPollable);
    const due = opts.allCompanies ? pollable : (await repo.listCompanies({ status: "active", dueForPoll: true })).filter(isCloudPollable);
    const limits = boardLimitsForSync({
      maxBoards: opts.maxBoards ?? env.maxBoards ?? "auto",
      timeBudgetMs: opts.timeBudgetMs ?? env.timeBudgetMs ?? DEFAULT_SYNC_TIME_BUDGET_MS,
      firstSync: !pollable.some((c) => c.lastPolled),
    });
    companies = orderBoardsForPoll(due, limits.maxBoards);
    deadline = Date.now() + limits.timeBudgetMs;
    stats.boardsDue = due.length;
    stats.boardsDeferred = due.length - companies.length;
    emit({
      type: "plan",
      boards: companies.length,
      deferred: stats.boardsDeferred,
      notDue: pollable.length - due.length,
      budgetMs: Number.isFinite(limits.timeBudgetMs) ? limits.timeBudgetMs : null,
      concurrency,
    });
    emit({ type: "phase", phase: "boards", state: "start" });
    if (stats.boardsDeferred) log(`  boards: ${companies.length} of ${due.length} due this run${limits.first ? " (first sync — the rest follow)" : ""}`);
  }
  // a cancelled run never diffs a board (no markStale) — even one whose fetch was in flight
  const mayStale = () => !signal?.aborted;
  await mapPoolKeyed(
    companies,
    { concurrency, perKey: 2, key: boardHostKey },
    async (c) => {
      if (c.atsType === "unknown" || !c.atsSlug) {
        emit({ type: "board", state: "deferred", id: c.id, name: c.name });
        return;
      }
      // past the time budget, or cancelled: leave it due (untouched), so it leads the next run
      if (Date.now() > deadline || signal?.aborted) {
        stats.boardsDeferred = (stats.boardsDeferred ?? 0) + 1;
        emit({ type: "board", state: "deferred", id: c.id, name: c.name });
        return;
      }
      const t0 = Date.now();
      emit({ type: "board", state: "start", id: c.id, name: c.name });
      try {
        const r = await ingestCompany(repo, c, {
          embedder,
          limit: opts.limitPerCompany,
          mayStale,
          ...(countries.length > 1 ? { countries } : { country: countries[0] }),
        });
        stats.companiesPolled++;
        stats.fetched += r.fetched;
        stats.staled += r.staled;
        stats.errors.push(...r.errors);
        const created = r.created ?? 0;
        emit({
          type: "board",
          state: "done",
          id: c.id,
          name: c.name,
          fetched: r.fetched,
          created,
          updated: Math.max(0, r.upserted - created),
          staled: r.staled,
          ms: Date.now() - t0,
          ...(r.errors[0] ? { error: r.errors[0] } : {}),
        });
      } catch (e) {
        stats.errors.push(`${c.name}: ${(e as Error).message}`);
        emit({ type: "board", state: "done", id: c.id, name: c.name, fetched: 0, created: 0, updated: 0, staled: 0, ms: Date.now() - t0, error: (e as Error).message });
        // a board whose fetch throws still takes its turn: left unmarked it would sort first
        // on every run and hold a slot of the per-run budget forever
        await repo.touchPolled(c.id).catch(() => {});
      }
    },
  );
  emit({ type: "phase", phase: "boards", state: "done" });
  log(`poll: ${stats.companiesPolled} boards, ${stats.fetched} postings, ${stats.staled} staled${stats.boardsDeferred ? ` · ${stats.boardsDeferred} due boards left for the next run` : ""}`);
  if (opts.companyId) {
    skip("feeds", "resolve", "expire");
    return stats;
  }
  if (signal?.aborted) {
    stats.cancelled = true;
    skip("feeds", "resolve", "expire");
    return stats;
  }

  // 2. discovery feeds (tier 1-2 only), custom sources, saved searches, community channels
  const feeds = (opts.feeds ?? plan?.feeds ?? []).filter((f) => !(opts.skipSlowFeeds && f.slow));
  const customTargets = plan && opts.customSources !== false ? [...plan.rssTargets, ...plan.jsonTargets, ...plan.threads] : [];
  const searchTargets = plan && opts.searches !== false ? plan.searchTargets : [];
  const envChannels = process.env.JOBFLOW_TELEGRAM_CHANNELS;
  const channels = opts.telegramChannels ?? (envChannels != null ? csv(envChannels) : (plan?.telegramChannels ?? []));
  emit({ type: "feeds", total: feeds.length + customTargets.length + searchTargets.length + channels.length });
  emit({ type: "phase", phase: "feeds", state: "start" });

  for (const feed of feeds) {
    if (signal?.aborted) break;
    const key = `feed:${feed.source}`;
    const t0 = Date.now();
    emit({ type: "source", state: "start", key, label: feed.source, kind: "feed" });
    const adapter = getAdapter(feed.source);
    if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) {
      stats.errors.push(`feed ${feed.source}: not a registered cloud adapter`);
      emit({ type: "source", state: "done", key, fetched: 0, created: 0, ms: 0, error: "not available on this machine" });
      continue;
    }
    let n = 0;
    let created = 0;
    let firstError: string | null = null;
    for (const target of feed.targets) {
      if (signal?.aborted) break;
      const r = await ingestFromAdapter(repo, adapter, target, { embedder });
      n += r.fetched;
      created += r.created ?? 0;
      stats.errors.push(...r.errors);
      firstError ??= r.errors[0] ?? null;
    }
    stats.feeds[feed.source] = (stats.feeds[feed.source] ?? 0) + n;
    stats.fetched += n;
    emit({ type: "source", state: "done", key, fetched: n, created, ms: Date.now() - t0, error: firstError });
    log(`  ${feed.source}: +${n}`);
  }

  // 2a. custom sources (RSS / JSON feeds / HN threads) — each run recorded on its rows
  if (customTargets.length && !signal?.aborted) {
    stats.custom = {};
    for (const t of customTargets) {
      if (signal?.aborted) break;
      const key = `custom:${t.configKey}`;
      const t0 = Date.now();
      emit({ type: "source", state: "start", key, label: customLabel(t), kind: "custom", ...(t.tenantIds ? { tenantIds: t.tenantIds } : {}) });
      const r = await runCustomSource(repo, t, embedder, stats);
      stats.custom[t.configKey] = r.fetched;
      stats.fetched += r.fetched;
      emit({ type: "source", state: "done", key, fetched: r.fetched, created: r.created, ms: Date.now() - t0, error: r.error });
    }
    log(`  custom sources: +${Object.values(stats.custom).reduce((a, b) => a + b, 0)}`);
  }

  // 2b. due saved searches → search-capable sources (ingested like any feed — idempotent)
  if (plan && searchTargets.length && !signal?.aborted) {
    stats.searches = await runSearchTargets(repo, searchTargets, embedder, stats, { emit, signal });
    log(`  saved searches: ${Object.keys(stats.searches).length} run`);
  }

  // 2c. community channels → company boards (the posting itself comes from the board)
  for (const channel of channels) {
    if (signal?.aborted) break;
    const key = `channel:${channel}`;
    const t0 = Date.now();
    emit({ type: "source", state: "start", key, label: `t.me/${channel}`, kind: "channel" });
    const msgs = await fetchTelegramChannel(channel, { pages: 2 });
    const h = await harvestLinks(repo, msgs, { origin: `telegram:${channel}` });
    stats.resolved.push(...h.boards);
    if (h.boards.length) emit({ type: "resolved", count: h.boards.length });
    emit({ type: "source", state: "done", key, fetched: msgs.length, created: 0, ms: Date.now() - t0, error: msgs.length ? null : "no messages came back" });
    log(`  telegram/${channel}: ${msgs.length} msgs → ${h.boards.length} boards (${h.skippedSuspicious} suspicious skipped)`);
  }
  emit({ type: "phase", phase: "feeds", state: "done" });
  if (signal?.aborted) {
    stats.cancelled = true;
    skip("resolve", "expire");
    return stats;
  }

  // 3. upgrade market-relevant company shells to their ATS boards (next poll hits them)
  emit({ type: "phase", phase: "resolve", state: "start" });
  const res = await resolveDiscoveredCompanies(repo, { max: opts.resolveMax, markets: countries.length ? countries : undefined });
  stats.resolved.push(...res.resolved);
  if (res.resolved.length) emit({ type: "resolved", count: res.resolved.length });
  if (res.tried) log(`  resolved ${res.resolved.length}/${res.tried} discovered companies`);
  emit({ type: "phase", phase: "resolve", state: "done" });
  if (signal?.aborted) {
    stats.cancelled = true;
    skip("expire");
    return stats;
  }

  // 4. expire non-board postings their source stopped returning
  emit({ type: "phase", phase: "expire", state: "start" });
  stats.expired = await repo.purgeOldPostings({ olderThanDays: FEED_TTL_DAYS, field: "lastSeen", sources: NON_BOARD_SOURCES });
  stats.expired += await expireUnseenBoardPostings(repo);
  if (stats.expired) log(`  expired ${stats.expired} postings unseen for ${FEED_TTL_DAYS}d (feeds) / ${BOARD_TTL_DAYS}d (boards)`);
  emit({ type: "expired", count: stats.expired });
  emit({ type: "phase", phase: "expire", state: "done" });

  return stats;
}

/** a custom source's label for progress: its host, never its full (private) URL */
function customLabel(t: CustomSourceTarget): string {
  const url = t.target.params?.url;
  if (typeof url === "string") {
    try {
      return new URL(url).host;
    } catch {
      /* fall through */
    }
  }
  return t.source === "hn_whoishiring" ? "HN thread" : t.source;
}

/**
 * Board postings unseen for BOARD_TTL_DAYS — but only where the board was FETCHED since
 * the posting was last seen (it came back empty, partial, or for another market set, so
 * markStale couldn't diff it). A board the per-run cap simply hasn't reached yet proves
 * nothing about its postings (invariant #5): with hundreds of boards and a capped or
 * time-boxed sync, a full rotation can outlast the TTL, and the old blanket sweep retired
 * live roles nobody had re-fetched. Boards that are paused, removed or not cloud-pollable
 * (local-agent boards) keep the plain TTL — nothing here will re-check them.
 */
export async function expireUnseenBoardPostings(repo: Repository, now = Date.now()): Promise<number> {
  const cutoff = now - BOARD_TTL_DAYS * DAY_MS;
  const nonBoard = new Set<string>(NON_BOARD_SOURCES);
  const old = (await repo.listActivePostings()).filter((p) => !nonBoard.has(p.source) && time(p.lastSeen) < cutoff);
  if (!old.length) return 0;
  const companies = new Map((await repo.listCompanies()).map((c) => [c.id, c]));
  const gone = old.filter((p) => {
    const c = companies.get(p.companyId);
    if (!c || c.status !== "active" || c.atsType === "unknown" || !c.atsSlug || !atsAdapter(c.atsType)) return true;
    return c.lastPolled != null && time(c.lastPolled) > time(p.lastSeen);
  });
  return repo.retirePostings(gone.map((p) => p.id));
}

const DAY_MS = 86_400_000;

function time(d: string | Date | null | undefined): number {
  return d ? new Date(d as string | Date).getTime() : 0;
}

/**
 * Which due boards this run polls, in order (§3 freshness): never-polled boards first, then
 * the most OVERDUE relative to their cadence. Among the never-polled, daily-cadence boards
 * come first and each group is taken round-robin across ATS types. Before, the never-polled
 * went in registry order, so a fresh install's first sweeps spent the run on one ATS family
 * (113 of 247 live boards are Workday, ~12 s a fetch) and the daily (high-value) seed boards
 * were reached last — at sync 10 of 10 with the old 25-board cap (audit 2026-11; now 1–2).
 *
 * Polled boards go by lateness = time since the last poll ÷ cadence period (a day, or a
 * week), not by plain age. Plain oldest-first starved the daily boards whenever the weekly
 * ones came due together (a week after the first sweep, ~200 boards all older than every
 * daily one), and under a cap it gave every board the same absolute gap, daily or not.
 * Lateness is the fair order either way: when every due board fits it changes nothing;
 * under a cap each board's gap stretches by the same factor of its own cadence. It never
 * outranks a never-polled board, so new boards are reached as fast as before.
 */
export function orderBoardsForPoll<C extends Pick<Company, "atsType" | "lastPolled" | "pollCadence">>(
  boards: readonly C[],
  max: number,
  now: number = Date.now(),
): C[] {
  const never = boards.filter((c) => !c.lastPolled);
  const fresh = [
    ...roundRobinByAts(never.filter((c) => c.pollCadence === "daily")),
    ...roundRobinByAts(never.filter((c) => c.pollCadence !== "daily")),
  ];
  const lateness = (c: C) => (now - time(c.lastPolled)) / cadenceMs(c.pollCadence);
  const seen = boards
    .filter((c) => c.lastPolled)
    .sort((a, b) => lateness(b) - lateness(a) || time(a.lastPolled) - time(b.lastPolled));
  return [...fresh, ...seen].slice(0, max);
}

/** a board's poll period (`dueForPoll` waits 20 h / 6 d, plus the spacing between runs). */
function cadenceMs(c: Company["pollCadence"]): number {
  return c === "daily" ? DAY_MS : 7 * DAY_MS;
}

/** A registry's very first sync (no board ever polled) stops here: it should answer fast. */
export const FIRST_SYNC_MAX_BOARDS = 25;
export const FIRST_SYNC_TIME_MS = 90_000;
/** The board-fetch time budget when the caller and the env set none (the worker, the cron). */
export const DEFAULT_SYNC_TIME_BUDGET_MS = 10 * 60_000;

/**
 * Resolve a run's board limits. "auto" = every due board, bounded by the time budget: the
 * due list is already the cadence-aware budget (daily boards come due daily, weekly ones
 * weekly, new ones at once), so it scales with the registry. A registry's first sync is
 * capped so the first results come fast; the next runs pick up the rest.
 */
export function boardLimitsForSync(o: { maxBoards: number | "auto"; timeBudgetMs: number; firstSync: boolean }): {
  maxBoards: number;
  timeBudgetMs: number;
  first: boolean;
} {
  if (o.maxBoards !== "auto") return { maxBoards: o.maxBoards, timeBudgetMs: o.timeBudgetMs, first: false };
  if (o.firstSync) return { maxBoards: FIRST_SYNC_MAX_BOARDS, timeBudgetMs: Math.min(o.timeBudgetMs, FIRST_SYNC_TIME_MS), first: true };
  return { maxBoards: Infinity, timeBudgetMs: o.timeBudgetMs, first: false };
}

/**
 * `JOBFLOW_SYNC_MAX_BOARDS` (a fixed per-sync board cap; unset or "auto" = every due board)
 * and `JOBFLOW_SYNC_MINUTES` (the board-fetch time budget). Invalid values are ignored
 * rather than turning syncing off.
 */
export function syncLimitsFromEnv(env: Record<string, string | undefined> = process.env): { maxBoards?: number; timeBudgetMs?: number } {
  const out: { maxBoards?: number; timeBudgetMs?: number } = {};
  const max = env.JOBFLOW_SYNC_MAX_BOARDS?.trim();
  if (max && max !== "auto" && Number.isInteger(Number(max)) && Number(max) > 0) out.maxBoards = Number(max);
  const mins = Number(env.JOBFLOW_SYNC_MINUTES?.trim() || NaN);
  if (mins > 0) out.timeBudgetMs = mins * 60_000;
  return out;
}

/** a registered board the cloud poll can fetch (local-agent-only ATSes are the agent's, invariant #1). */
function isCloudPollable(c: Company): boolean {
  return c.atsType !== "unknown" && !!c.atsSlug && !!atsAdapter(c.atsType);
}

/**
 * How far behind the board registry is: cloud-pollable active boards, how many were never
 * polled, how many are due. The web app's local schedule syncs again soon while any board
 * has never been polled (the first sync is capped) instead of waiting hours for its next run.
 */
export async function pollBacklog(repo: Repository): Promise<{ boards: number; neverPolled: number; due: number }> {
  const boards = (await repo.listCompanies({ status: "active" })).filter(isCloudPollable);
  const due = (await repo.listCompanies({ status: "active", dueForPoll: true })).filter(isCloudPollable);
  return { boards: boards.length, neverPolled: boards.filter((c) => !c.lastPolled).length, due: due.length };
}

/** interleave by ATS type, keeping each type's own order. */
function roundRobinByAts<C extends Pick<Company, "atsType">>(boards: C[]): C[] {
  const lanes = new Map<string, C[]>();
  for (const b of boards) {
    const lane = lanes.get(b.atsType);
    if (lane) lane.push(b);
    else lanes.set(b.atsType, [b]);
  }
  const out: C[] = [];
  const queues = [...lanes.values()];
  for (let k = 0; out.length < boards.length; k++) for (const q of queues) if (q[k]) out.push(q[k]!);
  return out;
}

/** one custom source: ingest (SSRF-guarded fetch inside the adapter), record the run, harvest ATS links. */
async function runCustomSource(
  repo: Repository,
  t: CustomSourceTarget,
  embedder: Embedder,
  stats: PollStats,
): Promise<{ fetched: number; created: number; error: string | null }> {
  const adapter = getAdapter(t.source);
  let fetched = 0;
  let created = 0;
  let error: string | null = null;
  if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) {
    error = `${t.source}: not a registered cloud adapter`;
  } else {
    let atsLinks: string[] = [];
    const r = await ingestFromAdapter(repo, adapter, t.target, {
      embedder,
      onRaws: (raws) => {
        atsLinks = atsLinksFromRaws(raws).slice(0, MAX_HARVEST_PER_FEED);
      },
    });
    fetched = r.fetched;
    created = r.created ?? 0;
    stats.errors.push(...r.errors);
    const feedKey = String(t.target.params?.feedKey ?? "");
    error = (feedKey ? takeFeedError(feedKey) : null) ?? r.errors[0] ?? null;
    // an item that links to an employer's own ATS also discovers that employer's board
    if (atsLinks.length) {
      const h = await harvestLinks(
        repo,
        atsLinks.map((text) => ({ text, postedAt: null })),
        { origin: `${t.source}:${feedKey || t.configKey.slice(0, 12)}` },
      ).catch(() => null);
      if (h) stats.resolved.push(...h.boards);
    }
  }
  if (error) stats.errors.push(`custom ${t.source}: ${error}`);
  const status = error ? "error" : fetched ? "ok" : "empty";
  for (const id of t.sourceIds) {
    await repo.recordDiscoverySourceRun(id, { status, count: fetched, error }).catch(() => {});
  }
  return { fetched, created, error };
}

/** run the plan's search targets; returns fetched counts per saved-search id (and records each run). */
export async function runSearchTargets(
  repo: Repository,
  targets: SearchTarget[],
  embedder: Embedder,
  stats?: Pick<PollStats, "fetched" | "errors">,
  progress: { emit?: PollListener; signal?: AbortSignal } = {},
): Promise<Record<string, number>> {
  const emit = progress.emit ?? (() => {});
  const perSearch: Record<string, number> = {};
  const owners = new Map<string, string>();
  const sourcesBySearch = new Map<string, Record<string, number>>();
  for (const [i, st] of targets.entries()) {
    if (progress.signal?.aborted) break;
    const adapter = getAdapter(st.source);
    if (!adapter || (adapter.tier !== "tier1" && adapter.tier !== "tier2")) continue; // invariant #1
    const key = `search:${st.source}:${i}`;
    const t0 = Date.now();
    const tenantIds = [...new Set(st.searches.map((s) => s.tenantId))];
    emit({ type: "source", state: "start", key, label: `saved search · ${st.source}`, kind: "search", tenantIds });
    const r = await ingestFromAdapter(repo, adapter, st.target, { embedder });
    emit({ type: "source", state: "done", key, fetched: r.fetched, created: r.created ?? 0, ms: Date.now() - t0, error: r.errors[0] ?? null });
    if (stats) {
      stats.fetched += r.fetched;
      stats.errors.push(...r.errors);
    }
    for (const s of st.searches) {
      owners.set(s.searchId, s.tenantId);
      perSearch[s.searchId] = (perSearch[s.searchId] ?? 0) + r.fetched;
      const bySource = sourcesBySearch.get(s.searchId) ?? {};
      bySource[st.source] = (bySource[st.source] ?? 0) + r.fetched;
      sourcesBySearch.set(s.searchId, bySource);
    }
  }
  for (const [searchId, tenantId] of owners) {
    await repo
      .recordSavedSearchRun(tenantId, searchId, { fetched: perSearch[searchId] ?? 0, sources: sourcesBySearch.get(searchId) ?? {}, via: "poll" })
      .catch(() => {});
  }
  return perSearch;
}

/** ATS links harvested from one custom feed per run (one detector probe each). */
const MAX_HARVEST_PER_FEED = 10;

/**
 * The host a board is served from, for per-host politeness: multi-tenant hosts
 * (Workday "{host}/{tenant}/{site}", Eightfold "{host}/{domain}") by their host, shared
 * APIs (Greenhouse, Lever, Ashby…) by ATS.
 */
function boardHostKey(c: Company): string {
  const first = (c.atsSlug ?? "").split("/")[0] ?? "";
  return first.includes(".") ? first.toLowerCase() : c.atsType;
}

function csv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}
