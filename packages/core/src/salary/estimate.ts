import type { Posting, SalaryEstimate } from "../schema/entities.js";
import type { RoleArchetype, SalaryConfidence } from "../schema/enums.js";
import {
  MARKET_CURRENCY,
  MARKET_LABEL,
  MID_LEVEL,
  ladderRatio,
  salaryLevelOf,
  salaryMarketOf,
  type SalaryMarket,
} from "./market.js";

/**
 * Salary estimation for postings that state none (§11.4). Pure: the pipeline hands in the
 * corpus's posted ranges and any cached benchmarks; nothing here touches the network.
 *
 * Evidence, strongest first:
 *   1. comparable POSTED ranges from our own corpus — same market only, weighted by role
 *      family, level distance and same-employer, each shifted to the target's level along
 *      the market's pay ladder;
 *   2. the employer's own pay data (AmbitionBox CTC by designation, levels.fyi company);
 *   3. market benchmarks (levels.fyi market×level, Adzuna role×level×country).
 * Each yields a band + its own confidence; they're blended in log space by confidence.
 *
 * Honesty rules: no market → no estimate; confidence is capped (0.85, bucket "medium") so
 * an estimate can never act as a stated salary; disagreeing sources widen the band and cut
 * confidence instead of being averaged into false precision.
 */

/** A posted salary range usable as a comparable. */
export interface CompSample {
  postingId: string;
  companyId: string;
  market: SalaryMarket;
  lo: number;
  mid: number;
  hi: number;
  archetype: RoleArchetype;
  titleNorm: string;
  level: number;
  levelKnown: boolean;
}

/** What we're pricing. */
export interface EstimateTarget {
  postingId: string;
  companyId: string;
  market: SalaryMarket;
  archetype: RoleArchetype;
  titleNorm: string;
  level: number;
  levelKnown: boolean;
}

/** An external / company pay figure, already in the target market's currency. */
export interface SalaryBenchmark {
  /** "levelsfyi" | "adzuna" | "ambitionbox" | … */
  source: string;
  scope: "market" | "company";
  currency: string;
  median: number;
  lo: number | null;
  hi: number | null;
  /** ladder index the figure describes; null = all levels pooled */
  level: number | null;
  /** 0..1 prior trust in this source for pricing a posting */
  reliability: number;
  /**
   * converts the source's pay basis to what postings state: levels.fyi reports total comp
   * (base + stock + bonus) while a US posting's range is base, so its figures are scaled down
   */
  toPosted?: number;
  /** "levels.fyi · India · senior" — for the basis line */
  detail: string;
}

/** One weighed piece of evidence. */
interface Component {
  source: string;
  /** market evidence prices the role anywhere; company evidence prices it at this employer */
  scope: "market" | "company";
  median: number;
  lo: number;
  hi: number;
  confidence: number;
  detail: string;
}

/** The cap: an estimate is never as good as a stated salary. */
export const MAX_ESTIMATE_CONFIDENCE = 0.85;
/** Below this the estimate isn't shown at all — a number with no support is worse than none. */
export const MIN_ESTIMATE_CONFIDENCE = 0.12;

/**
 * The employer's own evidence outweighs the market 2:1 in the blend: companies pay in
 * bands, so its posted ranges (or its AmbitionBox CTC) predict this role's pay better than
 * any market median — a 2× company premium is information, not noise.
 */
const COMPANY_BLEND_WEIGHT = 2;
const LEVEL_WEIGHT = [1, 0.45, 0.15]; // by ladder distance; 3+ levels apart carries nothing
const UNKNOWN_LEVEL_WEIGHT = 0.35;

const ENG = new Set<RoleArchetype>(["backend", "platform", "infra_devops", "sre", "fullstack", "frontend", "mobile", "data_ml"]);
const CORE = new Set<RoleArchetype>(["backend", "platform", "infra_devops", "sre", "fullstack"]);

/** A stated band with both ends becomes a comparable; floors/caps say too little. */
export function compSampleOf(p: Posting): CompSample | null {
  const s = p.salary;
  if (s.source === "none" || s.min == null || s.max == null) return null;
  if (s.confidence !== "high" && s.confidence !== "medium_high") return null;
  if (s.min <= 0 || s.max < s.min || s.max / s.min > 3) return null; // too wide to inform
  const market = salaryMarketOf(p.location);
  // a market's comps must be priced in its currency (a USD role "in India" is a different regime)
  if (!market || MARKET_CURRENCY[market] !== s.currency) return null;
  const lvl = salaryLevelOf(p.levelBand, p.experience);
  return {
    postingId: p.id,
    companyId: p.companyId,
    market,
    lo: s.min,
    mid: Math.sqrt(s.min * s.max),
    hi: s.max,
    archetype: p.roleArchetype,
    titleNorm: p.titleNorm,
    level: lvl.index,
    levelKnown: lvl.known,
  };
}

export function estimateTargetOf(p: Posting): EstimateTarget | null {
  const market = salaryMarketOf(p.location);
  if (!market) return null;
  const lvl = salaryLevelOf(p.levelBand, p.experience);
  return {
    postingId: p.id,
    companyId: p.companyId,
    market,
    archetype: p.roleArchetype,
    titleNorm: p.titleNorm,
    level: lvl.index,
    levelKnown: lvl.known,
  };
}

/** A posting already states pay → it's not estimated (and a stale estimate is cleared). */
export function hasStatedSalary(p: Pick<Posting, "salary">): boolean {
  return p.salary.source !== "none" && (p.salary.min != null || p.salary.max != null);
}

/**
 * Role-family similarity. Level dominates pay; within engineering the family moves it
 * ±10%, so adjacent families still count. Non-engineering ("other") is heterogeneous
 * (sales, legal, design) — it only borrows from the same canonical title.
 */
export function archetypeSimilarity(t: Pick<EstimateTarget, "archetype" | "titleNorm">, c: Pick<CompSample, "archetype" | "titleNorm">): number {
  const tEng = ENG.has(t.archetype);
  const cEng = ENG.has(c.archetype);
  if (tEng !== cEng) return 0;
  if (!tEng) return t.titleNorm === c.titleNorm ? 1 : 0.2;
  if (t.archetype === c.archetype) return 1;
  if (CORE.has(t.archetype) && CORE.has(c.archetype)) return 0.85;
  return 0.7;
}

export function estimateSalary(
  target: EstimateTarget,
  comps: readonly CompSample[],
  benchmarks: readonly SalaryBenchmark[] = [],
  now: Date = new Date(),
  calibration?: MarketCalibration,
): SalaryEstimate | null {
  const currency = MARKET_CURRENCY[target.market];
  const components: Component[] = [];

  const market = compsComponent(target, comps.filter((c) => c.companyId !== target.companyId), "market");
  const own = compsComponent(target, comps.filter((c) => c.companyId === target.companyId), "company");
  for (const c of [market, own]) if (c) components.push(c.component);

  for (const b of benchmarks) {
    if (b.currency !== currency || b.median <= 0) continue;
    const c = benchmarkComponent(target, b);
    if (c) components.push(c);
  }
  const usable = components.filter((c) => c.confidence >= 0.05);
  if (!usable.length) return null;

  // ── blend in log space, weighted by confidence (company evidence counts double) ──
  const bw = (c: Component) => c.confidence * (c.scope === "company" ? COMPANY_BLEND_WEIGHT : 1);
  const W = usable.reduce((s, c) => s + bw(c), 0);
  const logMed = usable.reduce((s, c) => s + bw(c) * Math.log(c.median), 0) / W;
  let loOff = usable.reduce((s, c) => s + bw(c) * Math.log(c.lo / c.median), 0) / W;
  let hiOff = usable.reduce((s, c) => s + bw(c) * Math.log(c.hi / c.median), 0) / W;

  // ── agreement WITHIN a scope: market sources should agree about the market, company
  //    sources about the company; disagreement widens the band and cuts confidence ──
  const solid = usable.filter((c) => c.confidence >= 0.15);
  const agree = Math.min(
    agreement(solid.filter((c) => c.scope === "market").map((c) => c.median)),
    agreement(solid.filter((c) => c.scope === "company").map((c) => c.median)),
  );
  loOff = Math.min(-0.08, loOff * (2 - agree));
  hiOff = Math.max(0.08, hiOff * (2 - agree));

  // independent evidence compounds (noisy-OR), then agreement scales it, then the cap
  const combined = 1 - usable.reduce((p, c) => p * (1 - c.confidence), 1);
  // "is there enough evidence?" is judged on the evidence itself; calibration then only
  // restates what that evidence is worth in this market — it relabels, never deletes
  if (combined * agree < MIN_ESTIMATE_CONFIDENCE) return null;
  const calFactor = Math.min(1, calibration?.factor ?? 1);
  const confidenceScore = round2(Math.min(MAX_ESTIMATE_CONFIDENCE, combined * agree * calFactor));

  const median = round3(Math.exp(logMed));
  return {
    min: round3(Math.exp(logMed + loOff)),
    median,
    max: round3(Math.exp(logMed + hiOff)),
    currency,
    confidence: confidenceBucket(confidenceScore),
    confidenceScore,
    sampleCount: (market?.used ?? 0) + (own?.used ?? 0),
    sources: usable.map((c) => ({ source: c.source, median: round3(c.median), weight: round2(c.confidence), detail: c.detail })),
    basis: [
      ...usable.map((c) => c.detail),
      ...(calFactor < 0.97 ? [`confidence ×${calFactor} from ${calibration!.n} backtested ${MARKET_LABEL[target.market]} postings`] : []),
    ].join(" · "),
    computedAt: now.toISOString(),
  };
}

/** Estimates top out at "medium": the hard floor only ever acts on a stated `high` band. */
export function confidenceBucket(score: number): SalaryConfidence {
  return score >= 0.6 ? "medium" : "low";
}

// ── component: comparable posted ranges ──────────────────────────────────────────

function compsComponent(
  target: EstimateTarget,
  comps: readonly CompSample[],
  scope: "market" | "company",
): { component: Component; used: number } | null {
  const pts: Array<{ v: number; w: number }> = [];
  let sw = 0;
  let sw2 = 0;
  let used = 0;
  let sameLevel = 0;

  for (const c of comps) {
    if (c.market !== target.market || c.postingId === target.postingId) continue;
    const arch = archetypeSimilarity(target, c);
    if (arch <= 0) continue;
    const d = Math.abs(c.level - target.level);
    const w = arch * Math.min(LEVEL_WEIGHT[d] ?? 0, c.levelKnown ? 1 : UNKNOWN_LEVEL_WEIGHT);
    if (w < 0.03) continue;

    // price the comp at the target's level (a senior range says little about a junior's
    // pay until it's walked down the market's ladder)
    const adj = ladderRatio(target.market, c.level, target.level);
    pts.push({ v: c.lo * adj, w: w * 0.25 }, { v: c.mid * adj, w: w * 0.5 }, { v: c.hi * adj, w: w * 0.25 });
    sw += w;
    sw2 += w * w;
    used++;
    if (d === 0 && c.levelKnown) sameLevel++;
  }
  // the employer's own single exact-match range is already real evidence; the market needs more
  if (sw < (scope === "company" ? 0.3 : 0.4)) return null;

  const nEff = (sw * sw) / sw2;
  const p25 = weightedQuantile(pts, 0.25);
  const p50 = weightedQuantile(pts, 0.5);
  const p75 = weightedQuantile(pts, 0.75);
  // mean similarity of what carried the weight (Σw²/Σw — each comp's weight IS its similarity)
  const fit = sw2 / sw;

  const confidence = Math.min(
    0.9,
    saturate(nEff, scope === "company" ? 1.5 : 4) * dispersionFactor(p75 / p25) * (0.5 + 0.5 * fit) * (target.levelKnown ? 1 : 0.8),
  );

  const lvl = sameLevel ? ` (${sameLevel} same level)` : "";
  const detail =
    scope === "company"
      ? `${used} posted range${used === 1 ? "" : "s"} at this company${lvl}`
      : `${used} similar posted range${used === 1 ? "" : "s"} in ${MARKET_LABEL[target.market]}${lvl}`;
  return {
    component: { source: scope === "company" ? "company_comps" : "corpus_comps", scope, median: p50, lo: p25, hi: p75, confidence, detail },
    used,
  };
}

// ── component: an external or company benchmark ──────────────────────────────────

function benchmarkComponent(target: EstimateTarget, b: SalaryBenchmark): Component | null {
  // a pooled (all-levels) figure sits around mid; a levelled one is walked to the target's level
  const from = b.level ?? MID_LEVEL;
  const d = Math.abs(from - target.level);
  const levelFit = b.level == null ? 0.75 : ([1, 0.8, 0.55][d] ?? 0.35);
  const scale = ladderRatio(target.market, from, target.level) * (b.toPosted ?? 1);
  const median = b.median * scale;
  const lo = (b.lo ?? b.median / 1.2) * scale;
  const hi = (b.hi ?? b.median * 1.2) * scale;
  if (!(lo > 0 && hi >= lo)) return null;
  const confidence = b.reliability * levelFit * (target.levelKnown ? 1 : 0.85);
  return { source: b.source, scope: b.scope, median, lo: Math.min(lo, median), hi: Math.max(hi, median), confidence, detail: b.detail };
}

// ── math ─────────────────────────────────────────────────────────────────────────

/** Weighted quantile over log-values (pay is log-normal-ish), linear between points. */
export function weightedQuantile(points: ReadonlyArray<{ v: number; w: number }>, q: number): number {
  const pts = points.filter((p) => p.v > 0 && p.w > 0).map((p) => ({ x: Math.log(p.v), w: p.w })).sort((a, b) => a.x - b.x);
  if (!pts.length) return NaN;
  if (pts.length === 1) return Math.exp(pts[0]!.x);
  const total = pts.reduce((s, p) => s + p.w, 0);
  // midpoint rule: each point sits at the centre of its weight mass
  let acc = 0;
  const pos = pts.map((p) => {
    const at = (acc + p.w / 2) / total;
    acc += p.w;
    return { x: p.x, at };
  });
  if (q <= pos[0]!.at) return Math.exp(pos[0]!.x);
  for (let i = 1; i < pos.length; i++) {
    const a = pos[i - 1]!;
    const b = pos[i]!;
    if (q <= b.at) {
      const t = b.at === a.at ? 0 : (q - a.at) / (b.at - a.at);
      return Math.exp(a.x + t * (b.x - a.x));
    }
  }
  return Math.exp(pos[pos.length - 1]!.x);
}

/** n/(n+k): 4 effective comps → 0.5, 12 → 0.75, 36 → 0.9. */
function saturate(n: number, k: number): number {
  return n / (n + k);
}

/** p75/p25 of 1.3 or tighter is a clear market rate (1.0); 2.5× apart is barely one (0.4). */
function dispersionFactor(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 1.3) return 1;
  if (ratio >= 2.5) return 0.4;
  return 1 - (0.6 * Math.log(ratio / 1.3)) / Math.log(2.5 / 1.3);
}

/** 1 when sources agree within 25%; falls to 0.55 by 2.2× apart. */
function agreement(medians: number[]): number {
  if (medians.length < 2) return 1;
  const r = Math.max(...medians) / Math.min(...medians);
  if (r <= 1.25) return 1;
  if (r >= 2.2) return 0.55;
  return 1 - (0.45 * Math.log(r / 1.25)) / Math.log(2.2 / 1.25);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
/** three significant figures: ₹18,40,000 not ₹18,37,412 — the precision is false anyway */
function round3(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const mag = 10 ** (Math.floor(Math.log10(x)) - 2);
  return Math.round(x / mag) * mag;
}

// ── calibration: make the score mean the same thing in every market ─────────────────

/** Per-market multiplier on confidence, learned from a leave-one-out backtest. */
export interface MarketCalibration {
  /** ≤ 1: calibration only ever LOWERS confidence, never inflates the model's own score */
  factor: number;
  /** backtested postings behind it */
  n: number;
}

export interface BacktestRow {
  market: string;
  confidence: number;
  /** |estimate median ÷ true midpoint − 1| */
  err: number;
}

const CAL_BANDS = [0, 0.3, 0.5, 0.7, 1.01];
const CAL_MIN_N = 5;
const CAL_SHRINK = 30; // n/(n+30): 30 backtests move a market halfway to its measured factor

/**
 * The global backtest maps confidence → typical error (e.g. ≥0.7 ≈ 8%, 0.3–0.5 ≈ 22%). A
 * market whose estimates miss by more than their confidence promises (India: company tier
 * swings pay 3×, so ~0.45 there behaves like ~0.2 elsewhere) gets its confidence scaled down
 * by expected÷actual error, shrunk toward 1 while its sample is small.
 */
export function calibrateByMarket(rows: readonly BacktestRow[]): Map<string, MarketCalibration> {
  const band = (c: number) => CAL_BANDS.findIndex((lo, i) => c >= lo && c < (CAL_BANDS[i + 1] ?? Infinity));
  // the reference curve for a market comes from the OTHER markets — a big market would
  // otherwise define its own baseline and always look calibrated
  const curve = (rs: readonly BacktestRow[]) => {
    const m = new Map<number, number>();
    for (let b = 0; b < CAL_BANDS.length - 1; b++) {
      const errs = rs.filter((r) => band(r.confidence) === b).map((r) => r.err);
      if (errs.length) m.set(b, median(errs));
    }
    return m;
  };
  const out = new Map<string, MarketCalibration>();
  for (const market of new Set(rows.map((r) => r.market))) {
    const rs = rows.filter((r) => r.market === market);
    if (rs.length < CAL_MIN_N) continue;
    const others = curve(rows.filter((r) => r.market !== market));
    if (!others.size) continue; // nothing to compare against
    const expected = median(rs.map((r) => others.get(band(r.confidence)) ?? r.err));
    const actual = median(rs.map((r) => r.err));
    if (!(actual > 0)) continue;
    const raw = Math.max(0.35, Math.min(1, expected / actual));
    const w = rs.length / (rs.length + CAL_SHRINK);
    out.set(market, { factor: round2(1 - w * (1 - raw)), n: rs.length });
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}
