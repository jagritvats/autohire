import type { Company, CompanyCompBenchmark, Posting, SalaryEstimate } from "@jobflow/core";
import {
  LevelBandOrder,
  MARKET_CURRENCY,
  MID_LEVEL,
  calibrateByMarket,
  compSampleOf,
  estimateSalary,
  estimateTargetOf,
  hasStatedSalary,
  parseStatedSalary,
  type BacktestRow,
  type EstimateTarget,
  type MarketCalibration,
  type SalaryBenchmark,
  type SalaryMarket,
} from "@jobflow/core";
import {
  ADZUNA_MARKET,
  LEVELS_MARKET_SLUG,
  adzunaQuery,
  familyMedianFor,
  fetchAdzunaSalary,
  fetchLevelsMarket,
  hasAdzunaKeys,
  type LevelsComp,
  type LevelsCompanyMarket,
  type LevelsMarketLevel,
} from "@jobflow/adapters";
import type { Repository, SalaryCacheEntry } from "@jobflow/db";

/**
 * Salary estimation, pipeline side (§11.4). The math is pure (`core/salary`); this file
 * gathers its evidence and persists the result:
 *
 *   estimatePostingSalaries   OFFLINE, cheap — prices every active posting that states no
 *                             pay from the corpus's posted ranges + cached benchmarks. Runs
 *                             after every poll, so estimates track the corpus.
 *   refreshSalaryBenchmarks   NETWORK, rate-limited, cloud-safe Tier 1 — levels.fyi
 *                             market×level pages and Adzuna role×level×country, cached.
 *   reparseStatedSalaries     backfill after an extractor fix (stored postings re-parsed).
 *   calibrateSalaryConfidence leave-one-out backtest → per-market confidence factors, so a
 *                             score means the same accuracy in every market.
 */

const ENG = new Set(["backend", "platform", "infra_devops", "sre", "fullstack", "frontend", "mobile", "data_ml"]);

/**
 * levels.fyi reports TOTAL comp (base + stock + bonus); postings state base (US pay-
 * transparency ranges) or CTC (India, which folds in variable pay but rarely stock). These
 * scale a levels figure to what a posting would say — priors, stated openly in the basis.
 */
const LEVELS_TC_TO_POSTED: Partial<Record<SalaryMarket, number>> = { US: 0.78, IN: 0.85 };
const LEVELS_TC_TO_POSTED_DEFAULT = 0.85;

const LEVELS_TTL_DAYS = 14;
const ADZUNA_TTL_DAYS = 14;
/** a miss is remembered briefly so a 404 isn't re-fetched every run */
const MISS_TTL_DAYS = 3;

// ── offline estimation ─────────────────────────────────────────────────────────────

export interface EstimateStats {
  /** postings with no stated pay that we tried to price */
  considered: number;
  estimated: number;
  /** estimates removed (the posting now states pay, or evidence dried up) */
  cleared: number;
  unchanged: number;
  /** no comparable or benchmark carried enough weight — left blank rather than guessed */
  noEvidence: number;
  /** no pay market could be inferred from the location — left blank on purpose */
  noMarket: number;
}

/** Prices one posting against the corpus's current evidence. */
export type SalaryEstimator = (
  posting: Posting,
  opts?: {
    /**
     * drop the employer's own posted ranges and benchmarks — prices the posting as if its
     * company had never published pay (the backtest's hard case, and the leak-free one)
     */
    withoutEmployerEvidence?: boolean;
  },
) => SalaryEstimate | null;

/**
 * The production estimator bound to today's evidence: every posted range in the corpus,
 * each company's benchmarks, and the cached market benchmarks. The offline pass and the
 * backtest both use this, so what's measured is exactly what ships.
 */
export async function loadSalaryEstimator(
  repo: Repository,
  opts: {
    now?: Date;
    postings?: Posting[];
    /** apply the cached per-market confidence calibration (default true; the backtest that
     *  derives it runs uncalibrated) */
    calibrated?: boolean;
  } = {},
): Promise<SalaryEstimator> {
  const now = opts.now ?? new Date();
  const active = opts.postings ?? (await repo.listActivePostings());
  const comps = active.map(compSampleOf).filter((c): c is NonNullable<typeof c> => c != null);
  const companies = new Map((await repo.listCompanies()).map((c) => [c.id, c]));
  const targets = active.map(estimateTargetOf).filter((t): t is EstimateTarget => t != null);
  const cache = await loadBenchmarkCache(repo, targets);
  const calibration = opts.calibrated === false ? new Map<string, MarketCalibration>() : await loadCalibration(repo);

  return (p, o = {}) => {
    const t = estimateTargetOf(p);
    if (!t) return null;
    const own = !o.withoutEmployerEvidence;
    const pool = own ? comps : comps.filter((c) => c.companyId !== p.companyId);
    const benchmarks = [...(own ? companyBenchmarks(companies.get(p.companyId), t) : []), ...marketBenchmarks(t, cache)];
    return estimateSalary(t, pool, benchmarks, now, calibration.get(t.market));
  };
}

export async function estimatePostingSalaries(repo: Repository, opts: { now?: Date } = {}): Promise<EstimateStats> {
  const stats: EstimateStats = { considered: 0, estimated: 0, cleared: 0, unchanged: 0, noEvidence: 0, noMarket: 0 };
  const active = await repo.listActivePostings();
  const estimate = await loadSalaryEstimator(repo, { now: opts.now, postings: active });

  const updates: Array<{ id: string; estimate: SalaryEstimate | null }> = [];
  for (const p of active) {
    if (hasStatedSalary(p)) {
      if (p.salaryEstimate) {
        updates.push({ id: p.id, estimate: null }); // stated pay wins; never show both
        stats.cleared++;
      }
      continue;
    }
    stats.considered++;
    const hasMarket = estimateTargetOf(p) != null;
    const est = hasMarket ? estimate(p) : null;
    if (!hasMarket) stats.noMarket++;
    else if (!est) stats.noEvidence++;
    if (sameEstimate(p.salaryEstimate ?? null, est)) {
      if (est) stats.unchanged++;
      continue;
    }
    updates.push({ id: p.id, estimate: est });
    if (est) stats.estimated++;
    else stats.cleared++;
  }
  if (updates.length) await repo.saveSalaryEstimates(updates);
  return stats;
}

function sameEstimate(a: SalaryEstimate | null, b: SalaryEstimate | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.min === b.min && a.median === b.median && a.max === b.max && a.currency === b.currency &&
    a.confidenceScore === b.confidenceScore && a.basis === b.basis
  );
}

// ── benchmarks → SalaryBenchmark ─────────────────────────────────────────────────────

/** Which levels.fyi page prices a ladder index: entry-level ≤ junior, senior ≥ senior. */
function levelsPageFor(level: number): { page: LevelsMarketLevel; level: number | null } {
  if (level <= LevelBandOrder.junior) return { page: "entry-level", level: LevelBandOrder.junior };
  if (level >= LevelBandOrder.senior) return { page: "senior", level: LevelBandOrder.senior };
  return { page: "all", level: null }; // the all-levels median sits around mid
}

function levelsKey(market: string, page: LevelsMarketLevel): string {
  return `lvm:v1:${market}:${page}`;
}
/** the level WORD is what varies the Adzuna query — mid has none, so it pools all levels */
function adzunaKey(market: string, archetype: string, level: number): string {
  return `adz:v2:${market}:${archetype}:${adzunaQuery(archetype as Posting["roleArchetype"], level)}`;
}

async function loadBenchmarkCache(repo: Repository, targets: EstimateTarget[]): Promise<Map<string, SalaryCacheEntry>> {
  const keys = new Set<string>();
  for (const t of targets) {
    if (!ENG.has(t.archetype)) continue;
    if (LEVELS_MARKET_SLUG[t.market]) keys.add(levelsKey(t.market, levelsPageFor(t.level).page));
    if (ADZUNA_MARKET[t.market]) keys.add(adzunaKey(t.market, t.archetype, t.level));
  }
  const out = new Map<string, SalaryCacheEntry>();
  for (const k of keys) {
    const e = await repo.getSalaryCache(k);
    if (e && e.estMedian != null) out.set(k, e);
  }
  return out;
}

function marketBenchmarks(t: EstimateTarget, cache: Map<string, SalaryCacheEntry>): SalaryBenchmark[] {
  if (!ENG.has(t.archetype)) return []; // both benchmarks are software-engineering figures
  const out: SalaryBenchmark[] = [];

  const lp = levelsPageFor(t.level);
  const lv = cache.get(levelsKey(t.market, lp.page));
  if (lv?.estMedian != null) {
    out.push({
      source: "levelsfyi",
      scope: "market",
      currency: lv.currency,
      median: lv.estMedian,
      lo: lv.estMin,
      hi: lv.estMax,
      level: lp.level,
      reliability: 0.4,
      toPosted: LEVELS_TC_TO_POSTED[t.market] ?? LEVELS_TC_TO_POSTED_DEFAULT,
      detail: `levels.fyi ${lp.page === "all" ? "all-levels" : lp.page} median${lv.sampleCount ? ` (${lv.sampleCount.toLocaleString("en-US")} reports)` : ""}, total comp scaled to posted pay`,
    });
  }

  const az = cache.get(adzunaKey(t.market, t.archetype, t.level));
  if (az?.estMedian != null) {
    const n = az.sampleCount ?? 0;
    out.push({
      source: "adzuna",
      scope: "market",
      currency: az.currency,
      median: az.estMedian,
      lo: az.estMin,
      hi: az.estMax,
      // the query named the level (senior/junior/…) unless it's mid, which pools every level
      level: t.level === MID_LEVEL ? null : t.level,
      reliability: 0.45 * (n / (n + 10)),
      detail: `Adzuna advertised pay (${n} ads)`,
    });
  }
  return out;
}

/** The employer's own pay: AmbitionBox CTC by designation (India), levels.fyi company (US). */
function companyBenchmarks(company: Company | undefined, t: EstimateTarget): SalaryBenchmark[] {
  if (!company || !ENG.has(t.archetype)) return [];
  const out: SalaryBenchmark[] = [];

  for (const b of company.compBenchmarks ?? []) {
    if (b.market !== t.market || !b.roles.length) continue;
    // the designation nearest the target's level; an unlevelled "Software Engineer" is
    // the base rung (≈ mid), trusted a little less
    const scored = b.roles.map((r) => {
      const lvl = r.levelBand ? LevelBandOrder[r.levelBand] : MID_LEVEL;
      return { r, lvl, d: Math.abs(lvl - t.level) };
    });
    scored.sort((x, y) => x.d - y.d || (y.r.n ?? 0) - (x.r.n ?? 0));
    const best = scored[0]!;
    // levels.fyi's employer ladders come from verified offer letters; AmbitionBox is
    // self-reported. An unlevelled designation is trusted less either way.
    const reliability = (b.source === "levelsfyi" ? 0.55 : 0.5) * (best.r.levelBand ? 1 : 0.8);
    out.push({
      source: `${b.source}_company`,
      scope: "company",
      currency: b.currency,
      median: best.r.median,
      lo: best.r.lo,
      hi: best.r.hi,
      level: best.lvl,
      reliability,
      toPosted: b.postedShare ?? (b.basis === "total_comp" ? (LEVELS_TC_TO_POSTED[t.market] ?? LEVELS_TC_TO_POSTED_DEFAULT) : 1),
      detail: `${sourceLabel(b.source)} ${company.name} ${best.r.title}${best.r.n ? ` (${best.r.n} salaries)` : ""}${b.basis === "total_comp" ? ", total comp scaled to posted pay" : ""}`,
    });
  }

  // levels.fyi's company page is US-scoped total comp, pooled across levels
  if (t.market === "US" && company.compSource === "levelsfyi" && company.compBreakdown?.length) {
    const levels: LevelsComp = {
      slug: "", currency: company.compCurrency ?? "USD", scopeLocation: "United States",
      medianAll: company.compMedian, families: company.compBreakdown, source: "levelsfyi", attribution: "",
    };
    const median = familyMedianFor(levels, t.archetype);
    if (median != null) {
      out.push({
        source: "levelsfyi_company",
        scope: "company",
        currency: levels.currency,
        median,
        lo: null,
        hi: null,
        level: null,
        reliability: 0.3,
        toPosted: LEVELS_TC_TO_POSTED.US,
        detail: `levels.fyi ${company.name} median (all levels, total comp scaled to posted pay)`,
      });
    }
  }
  return out;
}

function sourceLabel(source: string): string {
  return source === "ambitionbox" ? "AmbitionBox" : source === "glassdoor" ? "Glassdoor" : source === "levelsfyi" ? "levels.fyi" : source;
}

/** ladder index → the LevelBand a company level is stored under */
const INDEX_BAND = ["intern", "junior", "mid", "senior", "staff", "principal", "director"] as const;

/**
 * An employer's own level ladder for one market, as a company benchmark (levels.fyi
 * company × country). A miss is stored as `roles: []` so it isn't re-fetched every run.
 */
export function levelsCompanyBenchmark(
  lv: LevelsCompanyMarket | null,
  market: string,
  now: Date = new Date(),
): CompanyCompBenchmark {
  return {
    source: "levelsfyi",
    currency: lv?.currency ?? MARKET_CURRENCY[market as SalaryMarket] ?? "",
    market,
    basis: "total_comp",
    postedShare: lv?.postedShare ?? null,
    roles: (lv?.levels ?? []).map((l) => ({
      title: l.name,
      levelBand: INDEX_BAND[l.index] ?? null,
      median: l.median,
      lo: null,
      hi: null,
      n: null,
    })),
    fetchedAt: now.toISOString(),
  };
}

// ── network: refresh cached benchmarks ─────────────────────────────────────────────

export interface BenchmarkStats {
  levelsFetched: number;
  adzunaFetched: number;
  adzunaEnabled: boolean;
}

/**
 * Fetch the market benchmarks the estimator will need (cloud-safe Tier 1). levels.fyi: every
 * market with an engineering posting to price × the three level pages it publishes. Adzuna
 * (key-gated): one query per role×level×market among `postings` (the caller passes the top
 * matches — Adzuna's free tier is the scarce resource).
 */
export async function refreshSalaryBenchmarks(
  repo: Repository,
  opts: { postings?: Posting[] } = {},
): Promise<BenchmarkStats> {
  const stats: BenchmarkStats = { levelsFetched: 0, adzunaFetched: 0, adzunaEnabled: hasAdzunaKeys() };
  const active = await repo.listActivePostings();
  const targets = active.filter((p) => !hasStatedSalary(p)).map(estimateTargetOf).filter((t): t is EstimateTarget => !!t && ENG.has(t.archetype));

  const markets = new Set(targets.map((t) => t.market).filter((m) => LEVELS_MARKET_SLUG[m]));
  for (const market of markets) {
    for (const page of ["all", "entry-level", "senior"] as const) {
      const key = levelsKey(market, page);
      if (await repo.getSalaryCache(key)) continue;
      const lv = await fetchLevelsMarket(market, page);
      await repo.putSalaryCache({
        key, roleArchetype: "software_engineer", location: market,
        estMin: lv?.p25 ?? null, estMax: lv?.p75 ?? null, estMedian: lv?.median ?? null, sampleCount: lv?.sampleCount ?? null,
        currency: lv?.currency ?? "", source: "levelsfyi", confidence: "medium",
        ttlDays: lv ? LEVELS_TTL_DAYS : MISS_TTL_DAYS,
      });
      if (lv) stats.levelsFetched++;
    }
  }

  if (stats.adzunaEnabled) {
    const wanted = (opts.postings ?? []).filter((p) => !hasStatedSalary(p)).map(estimateTargetOf);
    const seen = new Set<string>();
    for (const t of wanted) {
      if (!t || !ENG.has(t.archetype) || !ADZUNA_MARKET[t.market]) continue;
      const key = adzunaKey(t.market, t.archetype, t.level);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await repo.getSalaryCache(key)) continue;
      const az = await fetchAdzunaSalary(t.market, t.archetype, t.level);
      await repo.putSalaryCache({
        key, roleArchetype: t.archetype, location: t.market,
        estMin: az?.p25 ?? null, estMax: az?.p75 ?? null, estMedian: az?.median ?? null, sampleCount: az?.sampleCount ?? null,
        currency: az?.currency ?? "", source: "adzuna", confidence: "medium",
        ttlDays: az ? ADZUNA_TTL_DAYS : MISS_TTL_DAYS,
      });
      if (az) stats.adzunaFetched++;
    }
  }
  return stats;
}

// ── backfill: re-parse stated salaries with the current extractor ────────────────────

/** Sources whose adapter sends a salary FIELD that may not appear in the JD text. */
const SALARY_FIELD_SOURCES = new Set([
  "lever", "ashby", "himalayas", "cutshort", "wellfound", "remotive", "adzuna", "careerjet", "jsearch", "reddit", "darwinbox",
]);

export interface ReparseStats {
  scanned: number;
  changed: number;
  /** bands that no longer parse (boilerplate read as pay) — now "none" */
  removed: number;
  /** field-sourced bands we can't re-verify until the next poll — kept, capped at medium */
  capped: number;
}

/**
 * Re-run the stated-salary parse over stored postings. Exact when the posting carries its
 * `salaryRaw`. Legacy rows (stored before it was kept) re-parse from the JD; a field-sourced
 * band (Lever/Ashby/…) that the JD alone can't reproduce may be real (the field isn't in the
 * JD) or may be an old boilerplate misparse — we can't tell, so it's kept at `medium`: never
 * a hard exclusion, never a comparable, half weight in scoring. The board's next poll
 * re-parses it exactly from the stored field.
 */
export async function reparseStatedSalaries(repo: Repository): Promise<ReparseStats> {
  const stats: ReparseStats = { scanned: 0, changed: 0, removed: 0, capped: 0 };
  for (const p of await repo.listActivePostings()) {
    stats.scanned++;
    const cur = p.salary;
    const had = hasStatedSalary(p); // read before the write: a repo may hand back live objects
    let next = parseStatedSalary(p.salaryRaw ?? null, p.jdText, p.location);
    if (next.source === "none" && had && p.salaryRaw == null && SALARY_FIELD_SOURCES.has(p.source)) {
      if (cur.confidence === "medium" || cur.confidence === "low") continue; // already capped
      next = { ...cur, confidence: "medium" };
      stats.capped++;
    }
    const same =
      (next.source === "none" && !had) ||
      (next.min === cur.min && next.max === cur.max && next.currency === cur.currency &&
        next.source === cur.source && next.confidence === cur.confidence);
    if (same) continue;
    await repo.updatePostingSalary(p.id, next);
    stats.changed++;
    if (next.source === "none" && had) stats.removed++;
  }
  return stats;
}

// ── backtest: does the confidence score mean anything? ───────────────────────────────

export interface BacktestBucket {
  label: string;
  n: number;
  /** share of hidden true midpoints inside the estimated p25–p75 band (≈50% if calibrated) */
  inBand: number;
  /** share whose true range overlaps the estimated band at all */
  overlap: number;
  /** median |estimate median ÷ true midpoint − 1| */
  medianError: number;
}

export interface BacktestReport {
  mode: "all-evidence" | "without-employer-evidence";
  calibrated: boolean;
  /** postings with a trustworthy stated range (the answer key) */
  evaluated: number;
  /** of those, how many got an estimate */
  answered: number;
  overall: BacktestBucket;
  byConfidence: BacktestBucket[];
  byMarket: BacktestBucket[];
  /** one row per re-estimated posting — what calibration learns from */
  rows: BacktestRow[];
}

/**
 * Hide each stated range, estimate it from everything else, compare (§11.4). The estimator
 * already excludes the target from its own comparables, so this is leave-one-out; with
 * `withoutEmployerEvidence` it also drops the employer's other ranges and benchmarks —
 * the leak-free view (a req cross-posted to five cities can't vouch for itself).
 */
export async function backtestSalaryEstimates(
  repo: Repository,
  opts: { withoutEmployerEvidence?: boolean; calibrated?: boolean } = {},
): Promise<BacktestReport> {
  const active = await repo.listActivePostings();
  const calibrated = opts.calibrated ?? true;
  const estimate = await loadSalaryEstimator(repo, { postings: active, calibrated });
  const rows: Array<{ conf: number; market: string; inBand: boolean; overlap: boolean; err: number }> = [];
  let evaluated = 0;
  for (const p of active) {
    const truth = compSampleOf(p);
    if (!truth) continue;
    evaluated++;
    const e = estimate(p, { withoutEmployerEvidence: opts.withoutEmployerEvidence });
    if (!e) continue;
    rows.push({
      conf: e.confidenceScore,
      market: truth.market,
      inBand: truth.mid >= e.min && truth.mid <= e.max,
      overlap: truth.hi >= e.min && truth.lo <= e.max,
      err: Math.abs(e.median / truth.mid - 1),
    });
  }
  const bucket = (label: string, rs: typeof rows): BacktestBucket => {
    const errs = rs.map((r) => r.err).sort((a, b) => a - b);
    return {
      label,
      n: rs.length,
      inBand: rs.length ? rs.filter((r) => r.inBand).length / rs.length : 0,
      overlap: rs.length ? rs.filter((r) => r.overlap).length / rs.length : 0,
      medianError: errs.length ? errs[Math.floor(errs.length / 2)]! : 0,
    };
  };
  const bands: Array<[string, number, number]> = [["< 0.30", 0, 0.3], ["0.30–0.50", 0.3, 0.5], ["0.50–0.70", 0.5, 0.7], ["≥ 0.70", 0.7, 1.01]];
  return {
    mode: opts.withoutEmployerEvidence ? "without-employer-evidence" : "all-evidence",
    calibrated,
    evaluated,
    answered: rows.length,
    overall: bucket("all", rows),
    byConfidence: bands.map(([l, lo, hi]) => bucket(l, rows.filter((r) => r.conf >= lo && r.conf < hi))),
    byMarket: [...new Set(rows.map((r) => r.market))].map((m) => bucket(m, rows.filter((r) => r.market === m))).sort((a, b) => b.n - a.n),
    rows: rows.map((r) => ({ market: r.market, confidence: r.conf, err: r.err })),
  };
}

// ── calibration ────────────────────────────────────────────────────────────────────────

const CAL_KEY = (market: string) => `cal:v1:${market}`;
const CAL_STAMP = "cal:v1:_run";
const CAL_TTL_DAYS = 7;

/**
 * Backtest the uncalibrated estimator leak-free (no employer evidence — the typical case)
 * and store a confidence factor per market, cached a week. A market without enough stated
 * ranges to judge keeps factor 1 (its stored entry is cleared).
 */
export async function calibrateSalaryConfidence(repo: Repository): Promise<Map<string, MarketCalibration>> {
  const bt = await backtestSalaryEstimates(repo, { withoutEmployerEvidence: true, calibrated: false });
  const cal = calibrateByMarket(bt.rows);
  for (const market of Object.keys(MARKET_CURRENCY)) {
    const c = cal.get(market);
    await repo.putSalaryCache({
      key: CAL_KEY(market), roleArchetype: null, location: market,
      estMin: null, estMax: null, estMedian: c?.factor ?? null, sampleCount: c?.n ?? null,
      currency: "", source: "backtest", confidence: "medium", ttlDays: CAL_TTL_DAYS,
    });
  }
  await repo.putSalaryCache({
    key: CAL_STAMP, estMin: null, estMax: null, estMedian: bt.rows.length, sampleCount: bt.rows.length,
    currency: "", source: "backtest", confidence: "medium", ttlDays: CAL_TTL_DAYS,
  });
  return cal;
}

/** Recalibrate when last week's calibration has expired (cheap, offline). */
export async function ensureSalaryCalibration(repo: Repository): Promise<boolean> {
  if (await repo.getSalaryCache(CAL_STAMP)) return false;
  await calibrateSalaryConfidence(repo);
  return true;
}

async function loadCalibration(repo: Repository): Promise<Map<string, MarketCalibration>> {
  const out = new Map<string, MarketCalibration>();
  for (const market of Object.keys(MARKET_CURRENCY)) {
    const e = await repo.getSalaryCache(CAL_KEY(market));
    if (e?.estMedian != null && e.sampleCount != null) out.set(market, { factor: e.estMedian, n: e.sampleCount });
  }
  return out;
}
