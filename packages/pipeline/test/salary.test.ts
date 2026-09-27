import { describe, expect, it } from "vitest";
import { InMemoryRepository, type NewPosting } from "@jobflow/db";
import { estimatePostingSalaries, reparseStatedSalaries } from "../src/salary.js";

const L = 100_000;
const BLR = { mode: "onsite", city: "Bengaluru", country: "India", timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 } as const;
const NONE = { min: null, max: null, currency: "INR", source: "none", confidence: "low" } as const;

let id = 0;
function newPosting(over: Partial<NewPosting> = {}): NewPosting {
  id++;
  return {
    companyId: `co${id}`, companyName: `Co ${id}`, atsType: "greenhouse", atsJobId: String(id), source: "greenhouse", tier: "tier1",
    title: "Senior Backend Engineer", titleNorm: "software-engineer", roleArchetype: "backend", levelBand: "senior",
    jdText: "Build services.", jdSkills: ["java"], requirements: [], location: { ...BLR }, salary: { ...NONE },
    experience: { min: null, max: null }, applyUrl: null, jdEmbedding: null, dedupKey: `k${id}`,
    ...over,
  };
}
function stated(lo: number, hi: number): NewPosting["salary"] {
  return { min: lo * L, max: hi * L, currency: "INR", source: "jd_direct", confidence: "high" };
}

async function corpus(repo: InMemoryRepository): Promise<void> {
  for (const [lo, hi] of [[38, 46], [40, 50], [42, 52], [36, 44], [45, 55], [40, 48]] as const) {
    await repo.upsertPosting(newPosting({ salary: stated(lo, hi) }));
  }
}

describe("estimatePostingSalaries (offline pass)", () => {
  it("prices a posting with no stated pay from the corpus, in its own field", async () => {
    const repo = new InMemoryRepository();
    await corpus(repo);
    const target = await repo.upsertPosting(newPosting());
    const stats = await estimatePostingSalaries(repo);
    expect(stats.estimated).toBe(1);

    const p = (await repo.getPosting(target.id))!;
    expect(p.salary.source).toBe("none"); // the stated band is never overwritten by a guess
    expect(p.salaryEstimate).toMatchObject({ currency: "INR", sampleCount: 6 });
    expect(p.salaryEstimate!.median).toBeGreaterThan(40 * L);
    expect(p.salaryEstimate!.median).toBeLessThan(50 * L);
    expect(p.salaryEstimate!.confidenceScore).toBeGreaterThan(0);
  });

  it("the estimate survives a re-poll, and a second pass is a no-op", async () => {
    const repo = new InMemoryRepository();
    await corpus(repo);
    const t = newPosting();
    await repo.upsertPosting(t);
    await estimatePostingSalaries(repo);
    const repolled = await repo.upsertPosting({ ...t }); // same posting, fresh poll
    expect(repolled.salaryEstimate).not.toBeNull();
    const again = await estimatePostingSalaries(repo);
    expect(again.estimated).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it("clears the estimate once the posting states its pay", async () => {
    const repo = new InMemoryRepository();
    await corpus(repo);
    const t = newPosting();
    const p = await repo.upsertPosting(t);
    await estimatePostingSalaries(repo);
    await repo.upsertPosting({ ...t, salary: stated(60, 70) });
    const stats = await estimatePostingSalaries(repo);
    expect(stats.cleared).toBe(1);
    expect((await repo.getPosting(p.id))!.salaryEstimate).toBeNull();
  });

  it("leaves a posting with no inferable pay market blank", async () => {
    const repo = new InMemoryRepository();
    await corpus(repo);
    const p = await repo.upsertPosting(
      newPosting({ location: { mode: "onsite", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.2 } }),
    );
    const stats = await estimatePostingSalaries(repo);
    expect(stats.noMarket).toBe(1);
    expect((await repo.getPosting(p.id))!.salaryEstimate ?? null).toBeNull();
  });
});

describe("reparseStatedSalaries (extractor-fix backfill)", () => {
  it("removes a band the fixed parser no longer finds in the JD", async () => {
    const repo = new InMemoryRepository();
    // the pre-fix parser read PhonePe's company boilerplate as ₹1.5 Cr pay
    const bogus = await repo.upsertPosting(
      newPosting({
        source: "greenhouse",
        jdText: "PhonePe processes an Annualized Total Payment Value (TPV) of over INR 150 lakh crore.",
        salary: { min: 15_000_000, max: null, currency: "INR", source: "jd_direct", confidence: "medium_high" },
      }),
    );
    const stats = await reparseStatedSalaries(repo);
    expect(stats.removed).toBe(1);
    expect((await repo.getPosting(bogus.id))!.salary.source).toBe("none");
  });

  it("keeps a salary-field band it can't re-verify from the JD, capped at medium", async () => {
    const repo = new InMemoryRepository();
    const lever = await repo.upsertPosting(
      newPosting({ source: "lever", atsType: "lever", jdText: "Build services.", salary: stated(30, 40), salaryRaw: null }),
    );
    const stats = await reparseStatedSalaries(repo);
    expect(stats.capped).toBe(1);
    const p = (await repo.getPosting(lever.id))!;
    expect(p.salary).toMatchObject({ min: 30 * L, max: 40 * L, confidence: "medium" });
    expect((await reparseStatedSalaries(repo)).changed).toBe(0); // idempotent
  });

  it("re-parses exactly from the stored salary field when there is one", async () => {
    const repo = new InMemoryRepository();
    const p = await repo.upsertPosting(
      newPosting({ source: "ashby", atsType: "ashby", salaryRaw: "₹30L – ₹40L", salary: { ...NONE } }),
    );
    await reparseStatedSalaries(repo);
    expect((await repo.getPosting(p.id))!.salary).toMatchObject({ min: 30 * L, max: 40 * L, confidence: "high" });
  });
});

describe("an employer's own level ladder (levels.fyi company × country)", () => {
  it("prices a posting off the employer's matching level, not the generic market", async () => {
    const { levelsCompanyBenchmark } = await import("../src/salary.js");
    const repo = new InMemoryRepository();
    await corpus(repo); // generic India senior market ≈ ₹45 L
    const amazon = await repo.upsertCompany({ name: "Amazon", nameNorm: "amazon" });
    await repo.saveCompanyEnrichment(amazon.id, {
      compBenchmark: levelsCompanyBenchmark(
        {
          slug: "amazon", market: "IN", currency: "INR", medianAll: 6_284_000, postedShare: 0.86, attribution: "",
          levels: [
            { name: "L4", median: 2_793_748, yoe: 2, index: 1 },
            { name: "L5", median: 6_640_622, yoe: 6.5, index: 2 },
            { name: "L6", median: 13_182_852, yoe: 11.5, index: 3 },
          ],
        },
        "IN",
      ),
    });
    const p = await repo.upsertPosting(newPosting({ companyId: amazon.id, companyName: "Amazon", title: "SDE II", levelBand: "mid" }));
    await estimatePostingSalaries(repo);
    const e = (await repo.getPosting(p.id))!.salaryEstimate!;
    expect(e.sources.map((s) => s.source)).toContain("levelsfyi_company");
    expect(e.basis).toMatch(/levels\.fyi Amazon L5/);
    // L5 ₹66 L total comp × 0.86 posted share ≈ ₹57 L, pulled from the market's ~₹30 L mid
    expect(e.median).toBeGreaterThan(40 * L);
  });

  it("a recorded miss (404) contributes nothing", async () => {
    const { levelsCompanyBenchmark } = await import("../src/salary.js");
    const miss = levelsCompanyBenchmark(null, "IN");
    expect(miss.roles).toEqual([]);
    expect(miss.currency).toBe("INR");
  });
});
