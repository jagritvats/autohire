import { describe, it, expect } from "vitest";
import { scorePosting, stackAdjacency, rankPostings } from "../src/match/index.js";
import type { Posting, Profile } from "../src/schema/index.js";

function makeProfile(over: Partial<Profile["prefs"]> = {}): Profile {
  return {
    id: "p1",
    tenantId: "t1",
    masterResume: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 2,
    levelBand: "mid",
    prefs: {
      salaryFloor: 2_000_000,
      currency: "INR",
      locationWeights: [
        { label: "remote", weight: 1 },
        { label: "bengaluru", weight: 0.85 },
        { label: "india", weight: 0.7 },
      ],
      stackMustHaves: [],
      stackProfile: ["java", "kafka", "postgres", "distributed_systems", "fintech_domain"],
      remoteGeoOk: ["india_ok", "worldwide"],
      relocate: true,
      targetArchetypes: ["backend", "platform"],
      ...over,
    },
  };
}

function makePosting(over: Partial<Posting> = {}): Posting {
  const now = new Date();
  return {
    id: "j1",
    companyId: "c1",
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: "1",
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "software-engineer",
    roleArchetype: "backend",
    levelBand: "mid",
    jdText: "",
    jdSkills: ["go", "kafka", "postgres", "distributed_systems"],
    requirements: [],
    location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
    salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: null,
    jdEmbedding: null,
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    canonicalId: null,
    dedupKey: "acme|software-engineer|remote:worldwide",
    ...over,
  };
}

describe("stack adjacency (§11.1 — don't gate on language)", () => {
  it("a Java profile is a strong transferable fit for a Go role with the systems core", () => {
    const res = stackAdjacency(["java", "kafka", "postgres", "distributed_systems"], ["go", "kafka", "postgres", "distributed_systems"]);
    expect(res.score).toBeGreaterThan(0.6);
    expect(res.languageStretch).toBe(true);
    expect(res.note).toMatch(/transferable/i);
  });

  it("a direct language match is noted as such", () => {
    const res = stackAdjacency(["java"], ["java", "kafka"]);
    expect(res.note).toMatch(/direct match/i);
  });

  it("never calls it a direct match when only a SECONDARY JD language is yours", () => {
    // a Scala-first role that also lists Go, for a Go developer
    const scala = stackAdjacency(["go", "kafka", "postgres"], ["scala", "go", "kafka"]);
    expect(scala.note).not.toMatch(/direct match/i);
    expect(scala.note).toMatch(/scala is new to you/i);
    expect(scala.note).toMatch(/also lists go/i);
    // a C#-first web role that also lists JavaScript, for a Java/JS developer
    const cs = stackAdjacency(["java", "javascript"], ["csharp", "javascript"]);
    expect(cs.note).not.toMatch(/direct match/i);
    expect(cs.languageStretch).toBe(false);
  });
});

describe("soft-weighted scoring", () => {
  it("ranks an on-target Go fintech role above a non-engineering role", () => {
    const profile = makeProfile();
    const eng = scorePosting(makePosting(), profile);
    const sales = scorePosting(
      makePosting({ title: "Account Executive", roleArchetype: "other", jdSkills: ["fintech_domain"] }),
      profile,
    );
    expect(eng.score).toBeGreaterThan(sales.score);
    expect(sales.flags.redFlags.join(" ")).toMatch(/non-engineering/i);
  });

  it("down-weights a us-only 'remote' and flags it (§11.3)", () => {
    const profile = makeProfile();
    const ok = scorePosting(makePosting(), profile);
    const usOnly = scorePosting(
      makePosting({ location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "us_only", sponsorship: null, confidence: 0.85 } }),
      profile,
    );
    expect(usOnly.breakdown.location).toBeLessThan(ok.breakdown.location);
    expect(usOnly.flags.redFlags.join(" ")).toMatch(/US-only/i);
  });

  it("notes a senior stretch-up without excluding it", () => {
    const res = scorePosting(makePosting({ levelBand: "senior" }), makeProfile());
    expect(res.rulePass).toBe(true);
    expect(res.flags.levelNote).toMatch(/stretch/i);
  });
});

describe("the only two hard exclusions (§11.3)", () => {
  it("excludes a high-confidence salary well below the floor", () => {
    const res = scorePosting(
      makePosting({ salary: { min: 800_000, max: 900_000, currency: "INR", source: "jd_direct", confidence: "high" } }),
      makeProfile({ salaryFloor: 2_000_000, currency: "INR" }),
    );
    expect(res.rulePass).toBe(false);
    expect(res.flags.hardExclusionReason).toMatch(/below your floor/i);
  });

  it("does NOT exclude on a low-confidence / unknown salary", () => {
    const res = scorePosting(
      makePosting({ salary: { min: 800_000, max: 900_000, currency: "INR", source: "model", confidence: "low" } }),
      makeProfile(),
    );
    expect(res.rulePass).toBe(true);
  });

  it("excludes an impossible onsite-abroad role only when relocate is off", () => {
    const posting = makePosting({
      location: { mode: "onsite", city: "Berlin", country: "Europe", timezone: null, remoteGeo: "unknown", sponsorship: false, confidence: 0.7 },
    });
    expect(scorePosting(posting, makeProfile({ relocate: true })).rulePass).toBe(true);
    expect(scorePosting(posting, makeProfile({ relocate: false })).rulePass).toBe(false);
  });
});

describe("India-onsite soft signal + honest confidence (§11.3)", () => {
  it("notes an onsite-India role as India-workable and keeps it rule-passing (not a gate)", () => {
    const res = scorePosting(
      makePosting({
        location: { mode: "onsite", city: "Bengaluru", country: "India", timezone: "Asia/Kolkata", remoteGeo: "unknown", sponsorship: null, confidence: 0.85 },
      }),
      makeProfile(),
    );
    expect(res.rulePass).toBe(true);
    expect(res.flags.locationNote ?? "").toMatch(/india-workable/i);
    expect(res.breakdown.location).toBeGreaterThan(0.5);
  });

  it("dampens the location score and flags 'verify' when the geo is low-confidence", () => {
    const profile = makeProfile();
    const confident = scorePosting(makePosting(), profile); // worldwide, confidence 0.9
    const unsure = scorePosting(
      makePosting({
        location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.3 },
      }),
      profile,
    );
    expect(unsure.breakdown.location).toBeLessThan(confident.breakdown.location);
    expect(unsure.flags.redFlags.join(" ")).toMatch(/uncertain|verify/i);
    expect(unsure.rulePass).toBe(true); // never a hard exclusion
  });

  it("adds a light YoE stretch note when the JD asks materially more than you have", () => {
    const res = scorePosting(
      makePosting({ experience: { min: 8, max: null } }), // profile yoe is 2
      makeProfile(),
    );
    expect(res.flags.redFlags.join(" ")).toMatch(/stretch/i);
    expect(res.rulePass).toBe(true);
  });
});

describe("rankPostings", () => {
  it("separates ranked (rule-passing) from excluded", () => {
    const profile = makeProfile({ salaryFloor: 2_000_000, currency: "INR" });
    const good = makePosting();
    const belowFloor = makePosting({
      id: "j2",
      atsJobId: "2",
      salary: { min: 500_000, max: 600_000, currency: "INR", source: "jd_direct", confidence: "high" },
    });
    const { ranked, excluded } = rankPostings([good, belowFloor], profile);
    expect(ranked.map((r) => r.postingId)).toContain("j1");
    expect(excluded.map((r) => r.postingId)).toContain("j2");
  });
});
