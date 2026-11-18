import { describe, it, expect } from "vitest";
import {
  calibrateByMarket,
  calibrateSalaryScores,
  calibrationKey,
  type BacktestRow,
  compSampleOf,
  convertCurrency,
  estimateSalary,
  estimateTargetOf,
  formatSalary,
  ladderRatio,
  salaryLevelOf,
  salaryMarketOf,
  weightedQuantile,
  type CompSample,
  type EstimateTarget,
  type SalaryBenchmark,
} from "../src/salary/index.js";
import { scorePosting, scoreSalary } from "../src/match/index.js";
import type { Posting, Profile, SalaryEstimate } from "../src/schema/index.js";

const L = 100_000; // one lakh

function target(over: Partial<EstimateTarget> = {}): EstimateTarget {
  return { postingId: "t", companyId: "acme", market: "IN", archetype: "backend", titleNorm: "software-engineer", level: 3, levelKnown: true, ...over };
}
let seq = 0;
function comp(lo: number, hi: number, over: Partial<CompSample> = {}): CompSample {
  return {
    postingId: `c${seq++}`, companyId: `co${seq}`, market: "IN", lo, mid: Math.sqrt(lo * hi), hi,
    archetype: "backend", titleNorm: "software-engineer", level: 3, levelKnown: true, ...over,
  };
}
/** n comps spread evenly between lo and hi medians (each a ±10% posted range) */
function spread(n: number, loMid: number, hiMid: number, over: Partial<CompSample> = {}): CompSample[] {
  return Array.from({ length: n }, (_, i) => {
    const m = loMid + ((hiMid - loMid) * i) / Math.max(1, n - 1);
    return comp(m * 0.9, m * 1.1, over);
  });
}

describe("salary market + level (what's comparable)", () => {
  const loc = (o: Partial<Posting["location"]>): Posting["location"] => ({
    mode: "onsite", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.8, ...o,
  });
  it("prices a posting in the market it's in, and refuses to guess otherwise", () => {
    expect(salaryMarketOf(loc({ country: "India", city: "Bengaluru" }))).toBe("IN");
    expect(salaryMarketOf(loc({ country: "Europe", city: "London" }))).toBe("GB");
    expect(salaryMarketOf(loc({ country: "Europe", city: "Berlin" }))).toBe("EU");
    expect(salaryMarketOf(loc({ city: "Singapore" }))).toBe("SG");
    expect(salaryMarketOf(loc({ mode: "remote", remoteGeo: "india_ok" }))).toBe("IN");
    expect(salaryMarketOf(loc({ mode: "remote", remoteGeo: "us_only" }))).toBe("US");
    expect(salaryMarketOf(loc({ mode: "remote", remoteGeo: "worldwide" }))).toBe("REMOTE");
    expect(salaryMarketOf(loc({ city: "Tbilisi" }))).toBeNull();
  });

  it("reads level from the title band, else the asked years, else assumes mid and says so", () => {
    expect(salaryLevelOf("senior", null)).toEqual({ index: 3, known: true });
    expect(salaryLevelOf(null, { min: 6, max: null })).toEqual({ index: 3, known: true });
    expect(salaryLevelOf(null, { min: 1, max: 3 })).toEqual({ index: 1, known: true });
    expect(salaryLevelOf(null, { min: null, max: null })).toEqual({ index: 2, known: false });
  });

  it("India's ladder is steeper than the US one (levels.fyi: entry÷senior 0.27 vs 0.57)", () => {
    expect(ladderRatio("IN", 1, 3)).toBeGreaterThan(3);
    expect(ladderRatio("US", 1, 3)).toBeLessThan(2);
    expect(ladderRatio("IN", 3, 3)).toBe(1);
  });
});

describe("comparable postings", () => {
  const posting = (salary: Posting["salary"], over: Partial<Posting> = {}): Posting =>
    ({
      id: "p", companyId: "co", titleNorm: "software-engineer", roleArchetype: "backend", levelBand: "senior",
      experience: { min: null, max: null }, salary,
      location: { mode: "onsite", city: "Pune", country: "India", timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 },
      ...over,
    }) as Posting;

  it("uses stated ranges only — not floors, not weak parses, not a foreign currency", () => {
    expect(compSampleOf(posting({ min: 30 * L, max: 40 * L, currency: "INR", source: "jd_direct", confidence: "high" }))).not.toBeNull();
    expect(compSampleOf(posting({ min: 30 * L, max: null, currency: "INR", source: "jd_direct", confidence: "high" }))).toBeNull();
    expect(compSampleOf(posting({ min: 30 * L, max: 40 * L, currency: "INR", source: "jd_direct", confidence: "medium" }))).toBeNull();
    // a USD band on an India-located role is a different pay regime
    expect(compSampleOf(posting({ min: 90_000, max: 120_000, currency: "USD", source: "jd_direct", confidence: "high" }))).toBeNull();
  });
});

describe("estimateSalary", () => {
  it("prices from same-market comps and reports a p25–p75 band", () => {
    const est = estimateSalary(target(), spread(12, 35 * L, 55 * L))!;
    expect(est.currency).toBe("INR");
    expect(est.median).toBeGreaterThan(40 * L);
    expect(est.median).toBeLessThan(50 * L);
    expect(est.min).toBeLessThan(est.median);
    expect(est.max).toBeGreaterThan(est.median);
    expect(est.sampleCount).toBe(12);
    expect(est.basis).toMatch(/12 similar posted ranges in India \(12 same level\)/);
  });

  it("never borrows across markets", () => {
    expect(estimateSalary(target(), spread(20, 150_000, 200_000, { market: "US" }))).toBeNull();
  });

  it("walks other-level comps along the ladder instead of taking them at face value", () => {
    // only junior comps (~12 LPA): a senior estimate must land far above them
    const est = estimateSalary(target({ level: 3 }), spread(15, 10 * L, 14 * L, { level: 1 }))!;
    expect(est.median).toBeGreaterThan(30 * L);
    expect(est.median).toBeLessThan(55 * L);
  });

  it("weights the employer's own posted ranges above the market", () => {
    const market = spread(10, 20 * L, 26 * L);
    const own = spread(3, 45 * L, 50 * L, { companyId: "acme" });
    const est = estimateSalary(target(), [...market, ...own])!;
    expect(est.median).toBeGreaterThan(30 * L);
    expect(est.basis).toMatch(/3 posted ranges at this company/);
    expect(est.sources.map((x) => x.source).sort()).toEqual(["company_comps", "corpus_comps"]);
  });

  it("does not price an engineering role off sales/legal postings", () => {
    const est = estimateSalary(target(), spread(20, 10 * L, 90 * L, { archetype: "other", titleNorm: "account-executive" }));
    expect(est).toBeNull();
  });

  it("confidence grows with sample size and shrinks with spread", () => {
    const few = estimateSalary(target(), spread(3, 38 * L, 42 * L))!;
    const many = estimateSalary(target(), spread(25, 38 * L, 42 * L))!;
    const wide = estimateSalary(target(), spread(25, 15 * L, 90 * L))!;
    expect(many.confidenceScore).toBeGreaterThan(few.confidenceScore);
    expect(wide.confidenceScore).toBeLessThan(many.confidenceScore);
  });

  it("an unknown target level costs confidence", () => {
    const comps = spread(12, 38 * L, 42 * L);
    const known = estimateSalary(target(), comps)!;
    const unknown = estimateSalary(target({ levelKnown: false }), comps)!;
    expect(unknown.confidenceScore).toBeLessThan(known.confidenceScore);
  });

  it("is never as confident as a stated salary, however much evidence agrees", () => {
    const bench: SalaryBenchmark = { source: "levelsfyi", scope: "market", currency: "INR", median: 40 * L, lo: 33 * L, hi: 49 * L, level: 3, reliability: 0.5, detail: "levels.fyi" };
    const est = estimateSalary(target(), [...spread(80, 39 * L, 41 * L), ...spread(5, 39 * L, 41 * L, { companyId: "acme" })], [bench])!;
    expect(est.confidenceScore).toBeLessThanOrEqual(0.85);
    expect(est.confidence).toBe("medium"); // never high / medium_high
  });

  it("a benchmark alone yields a low-confidence estimate, labeled by source", () => {
    const bench: SalaryBenchmark = { source: "levelsfyi", scope: "market", currency: "INR", median: 49.8 * L, lo: 32.9 * L, hi: 73.9 * L, level: 3, reliability: 0.45, toPosted: 0.85, detail: "levels.fyi · India · senior" };
    const est = estimateSalary(target(), [], [bench])!;
    expect(est.confidence).toBe("low");
    expect(est.sources.map((s) => s.source)).toEqual(["levelsfyi"]);
    expect(est.median).toBeCloseTo(49.8 * L * 0.85, -4);
    expect(est.sampleCount).toBe(0);
  });

  it("disagreeing sources widen the band and cut confidence instead of averaging to false precision", () => {
    const comps = spread(12, 38 * L, 42 * L);
    const agreeing: SalaryBenchmark = { source: "adzuna", scope: "market", currency: "INR", median: 41 * L, lo: null, hi: null, level: 3, reliability: 0.4, detail: "adzuna" };
    const clashing: SalaryBenchmark = { ...agreeing, median: 110 * L };
    const a = estimateSalary(target(), comps, [agreeing])!;
    const b = estimateSalary(target(), comps, [clashing])!;
    expect(b.confidenceScore).toBeLessThan(a.confidenceScore);
    expect(b.max / b.min).toBeGreaterThan(a.max / a.min);
  });

  it("ignores a benchmark in another currency", () => {
    const usd: SalaryBenchmark = { source: "levelsfyi", scope: "company", currency: "USD", median: 250_000, lo: null, hi: null, level: null, reliability: 0.4, detail: "levels.fyi company" };
    expect(estimateSalary(target(), [], [usd])).toBeNull();
  });
});

describe("per-market confidence calibration", () => {
  // global curve: confident estimates miss by ~8%, unsure ones by ~40%
  const good = (market: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ market, confidence: i % 2 ? 0.75 : 0.2, err: i % 2 ? 0.08 : 0.4 }));

  it("scales down a market whose estimates miss by more than their confidence promises", () => {
    const india = Array.from({ length: 40 }, () => ({ market: "IN", confidence: 0.75, err: 0.35 }));
    const cal = calibrateByMarket([...good("US", 400), ...india]);
    expect(cal.get("IN")!.factor).toBeLessThan(0.75);
    expect(cal.get("US")!.factor).toBeGreaterThan(0.95);
  });

  it("never inflates, and leaves tiny samples alone", () => {
    const better = Array.from({ length: 50 }, () => ({ market: "CA", confidence: 0.2, err: 0.01 }));
    const cal = calibrateByMarket([...good("US", 200), ...better, { market: "SG", confidence: 0.5, err: 0.9 }]);
    expect(cal.get("CA")!.factor).toBe(1);
    expect(cal.has("SG")).toBe(false);
  });

  it("shrinks toward 1 while the sample is small", () => {
    const few = Array.from({ length: 6 }, () => ({ market: "IN", confidence: 0.75, err: 0.35 }));
    const many = Array.from({ length: 200 }, () => ({ market: "IN", confidence: 0.75, err: 0.35 }));
    const a = calibrateByMarket([...good("US", 400), ...few]).get("IN")!.factor;
    const b = calibrateByMarket([...good("US", 400), ...many]).get("IN")!.factor;
    expect(a).toBeGreaterThan(b);
  });

  it("is applied to the estimate and said out loud in its basis", () => {
    const comps = spread(12, 38 * L, 42 * L);
    const raw = estimateSalary(target(), comps)!;
    const cal = estimateSalary(target(), comps, [], new Date(), { factor: 0.6, n: 39 })!;
    expect(cal.confidenceScore).toBeCloseTo(raw.confidenceScore * 0.6, 1);
    expect(cal.basis).toMatch(/confidence ×0\.6 from 39 backtested India postings/);
  });

  it("relabels a weak estimate instead of deleting it", () => {
    // three one-level-off comps for a target of unknown level: real but thin evidence
    const weak = spread(3, 30 * L, 40 * L, { level: 3 });
    const raw = estimateSalary(target({ level: 2, levelKnown: false }), weak)!;
    expect(raw.confidenceScore).toBeLessThan(0.35);
    const cal = estimateSalary(target({ level: 2, levelKnown: false }), weak, [], new Date(), { factor: 0.35, n: 100 });
    expect(cal).not.toBeNull();
    expect(cal!.confidenceScore).toBeLessThan(raw.confidenceScore);
  });
});

describe("per market × role family calibration (audit 2026-11 follow-up)", () => {
  const BANDS: Array<[number, number]> = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.01]];
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  /** median error per confidence band, after applying a calibration */
  function curve(rows: BacktestRow[], cal: Map<string, { factor: number }>): number[] {
    const c = rows.map((r) => ({ err: r.err, conf: r.confidence * (cal.get(calibrationKey(r.market, r.family ?? "eng"))?.factor ?? 1) }));
    return BANDS.map(([lo, hi]) => c.filter((r) => r.conf >= lo && r.conf < hi).map((r) => r.err)).filter((e) => e.length).map(med);
  }
  const rows = (market: string, family: "eng" | "other", n: number, confidence: number, err: number): BacktestRow[] =>
    Array.from({ length: n }, (_, i) => ({ market, family, confidence, err: err * (0.9 + (i % 3) * 0.1) }));

  // the shape the live corpora showed: engineering estimates are well ordered (0.35 → 19%,
  // 0.6 → 15%, 0.8 → 9%), but non-engineering ones sit at ~0.5 whatever their evidence
  // and miss by ~21% — so the 0.5–0.7 band read worse than the 0.3–0.5 one
  const corpus = [
    ...rows("US", "eng", 300, 0.38, 0.19),
    ...rows("US", "eng", 150, 0.6, 0.15),
    ...rows("US", "eng", 400, 0.8, 0.09),
    ...rows("US", "other", 900, 0.52, 0.21),
    ...rows("US", "other", 100, 0.2, 0.4),
    ...rows("IN", "eng", 80, 0.45, 0.41),
  ];

  it("restores error-by-confidence monotonicity by scaling down the over-confident family", () => {
    const before = curve(corpus, new Map());
    expect(before[1]!).toBeLessThan(before[2]!); // the inversion
    const cal = calibrateSalaryScores(corpus);
    const after = curve(corpus, cal);
    for (let i = 1; i < after.length; i++) expect(after[i]!).toBeLessThanOrEqual(after[i - 1]!);
    expect(cal.get("US:other")!.factor).toBeLessThan(0.97);
    expect(cal.get("US:eng")!.factor).toBe(1); // the well-ordered family keeps its scores
  });

  it("keeps the market step: a market missing by more than its scores promise is scaled as before", () => {
    const cal = calibrateSalaryScores(corpus);
    expect(cal.get("IN:eng")!.factor).toBe(calibrateByMarket(corpus).get("IN")!.factor);
    expect(cal.get("IN:eng")!.factor).toBeLessThan(0.8);
    expect(cal.has("IN:other")).toBe(false); // no rows → no calibration (factor 1)
  });

  it("never inflates and leaves a small family alone", () => {
    const better = [...rows("US", "eng", 300, 0.38, 0.19), ...rows("US", "other", 300, 0.3, 0.05)];
    expect(calibrateSalaryScores(better).get("US:other")!.factor).toBe(1);
    const few = [...rows("US", "eng", 300, 0.6, 0.1), ...rows("US", "other", 3, 0.6, 0.4)];
    expect(calibrateSalaryScores(few).get("US:other")!.factor).toBe(1);
  });

  it("names the family in the estimate's basis", () => {
    const comps = spread(12, 38 * L, 42 * L);
    const est = estimateSalary(target({ archetype: "other", titleNorm: "account-executive" }), comps.map((c) => ({ ...c, archetype: "other" as const, titleNorm: "account-executive" })), [], new Date(), { factor: 0.8, n: 900 })!;
    expect(est.basis).toMatch(/confidence ×0\.8 from 900 backtested non-engineering India postings/);
  });
});

describe("weightedQuantile", () => {
  it("interpolates in log space and respects weights", () => {
    const pts = [{ v: 100, w: 1 }, { v: 400, w: 1 }];
    expect(weightedQuantile(pts, 0.5)).toBeCloseTo(200, 5); // geometric midpoint
    expect(weightedQuantile([{ v: 100, w: 9 }, { v: 400, w: 1 }], 0.5)).toBeLessThan(150);
  });
});

describe("FX + formatting", () => {
  it("converts through USD and refuses unknown currencies", () => {
    expect(convertCurrency(100_000, "USD", "INR")).toBeCloseTo(9_582_000, -2);
    expect(convertCurrency(100, "INR", "INR")).toBe(100);
    expect(convertCurrency(100, "XYZ", "INR")).toBeNull();
  });
  it("formats Indian units and compact k", () => {
    expect(formatSalary(1_850_000, "INR")).toBe("₹18.5L");
    expect(formatSalary(12_000_000, "INR")).toBe("₹1.2Cr");
    expect(formatSalary(185_000, "USD")).toBe("$185k");
    expect(formatSalary(139_000, "CAD")).toBe("CA$139k");
  });
});

// ── scoring: estimates are soft, FX-aware, and can never hard-exclude ────────────
function profile(over: Partial<Profile["prefs"]> = {}): Profile {
  return {
    id: "p1", tenantId: "t1", masterResume: "", aboutText: "", profileEmbedding: null, yoe: 3, levelBand: "mid",
    prefs: {
      salaryFloor: 20 * L, currency: "INR", locationWeights: [{ label: "remote", weight: 1 }], stackMustHaves: [],
      stackProfile: ["java"], remoteGeoOk: ["india_ok", "worldwide"], relocate: true, targetArchetypes: ["backend"], ...over,
    },
  } as Profile;
}
function posting(over: Partial<Posting> = {}): Posting {
  const now = new Date();
  return {
    id: "j1", companyId: "c1", companyName: "Acme", atsType: "greenhouse", atsJobId: "1", source: "greenhouse", tier: "tier1",
    title: "Backend Engineer", titleNorm: "software-engineer", roleArchetype: "backend", levelBand: "mid", jdText: "", jdSkills: ["java"],
    requirements: [], location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
    salary: { min: null, max: null, currency: "INR", source: "none", confidence: "low" }, experience: { min: null, max: null },
    applyUrl: null, jdEmbedding: null, firstSeen: now, lastSeen: now, isActive: true, repostCount: 0, canonicalId: null, dedupKey: "k",
    ...over,
  } as Posting;
}
function estimate(maxLakhs: number, confidenceScore: number): SalaryEstimate {
  return {
    min: maxLakhs * 0.7 * L, median: maxLakhs * 0.85 * L, max: maxLakhs * L, currency: "INR", confidence: confidenceScore >= 0.6 ? "medium" : "low",
    confidenceScore, sampleCount: 10, sources: [], basis: "", computedAt: new Date().toISOString(),
  };
}

describe("scoreSalary", () => {
  it("converts a USD band into the profile's currency before comparing to the floor", () => {
    const p = posting({ salary: { min: 120_000, max: 150_000, currency: "USD", source: "jd_direct", confidence: "high" } });
    expect(scoreSalary(p, profile()).score).toBe(1); // $150k ≈ ₹1.4 Cr ≫ ₹20 L
  });

  it("a weak estimate barely moves the score; a confident one below floor is flagged", () => {
    const weak = scoreSalary(posting({ salaryEstimate: estimate(10, 0.2) }), profile());
    const strong = scoreSalary(posting({ salaryEstimate: estimate(10, 0.7) }), profile());
    expect(weak.score).toBeGreaterThan(strong.score);
    expect(weak.flag).toBeNull();
    expect(strong.flag).toMatch(/Estimated pay .* 70% confidence.* below your floor/);
  });

  it("an estimate below the floor never hard-excludes (invariant #4)", () => {
    const res = scorePosting(posting({ salaryEstimate: estimate(5, 0.85) }), profile());
    expect(res.rulePass).toBe(true);
    expect(res.flags.hardExclusionReason).toBeNull();
  });

  it("a stated floor-only band never hard-excludes — it says nothing about the ceiling", () => {
    const res = scorePosting(
      posting({ salary: { min: 6 * L, max: null, currency: "INR", source: "jd_direct", confidence: "high" } }),
      profile(),
    );
    expect(res.rulePass).toBe(true);
  });
});

describe("estimateTargetOf", () => {
  it("has no target without a market", () => {
    const p = posting({ location: { mode: "onsite", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.3 } });
    expect(estimateTargetOf(p)).toBeNull();
  });
});
