import { describe, it, expect } from "vitest";
import { idOrderPostedBounds, repostSafeDates } from "../src/normalize/index.js";
import { isAiTrainingGig, postingAgeDays, scorePosting, scoreSourceTrust } from "../src/match/index.js";
import { LOCAL_EMBEDDER_ID, embedOrigin, localEmbed } from "../src/util/embed.js";
import type { Posting, Profile } from "../src/schema/index.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 27);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function profile(): Profile {
  return {
    id: "p1", tenantId: "t1", masterResume: "", resumeLatex: "", aboutText: "", profileEmbedding: null, yoe: 2, levelBand: "mid",
    prefs: {
      salaryFloor: 0, currency: "INR",
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [{ label: "remote", weight: 1 }, { label: "bengaluru", weight: 0.85 }],
      stackMustHaves: [], stackProfile: ["python", "java", "postgres", "docker"],
      remoteGeoOk: ["india_ok", "worldwide"], relocate: true, targetArchetypes: ["backend", "platform"],
    },
  };
}

function posting(over: Partial<Posting> = {}): Posting {
  const now = new Date();
  return {
    id: "j1", companyId: "c1", companyName: "Acme", atsType: "unknown", atsJobId: "himalayas:1", source: "himalayas", tier: "tier1",
    title: "Backend Engineer", titleNorm: "software-engineer", roleArchetype: "backend", levelBand: "mid",
    jdText: "", jdSkills: ["python", "docker", "postgres"], requirements: [],
    location: { mode: "remote", city: null, country: "India", timezone: null, remoteGeo: "india_ok", sponsorship: null, confidence: 0.9 },
    salary: { min: null, max: null, currency: "INR", source: "none", confidence: "low" },
    experience: { min: null, max: null }, applyUrl: null, jdEmbedding: null,
    postedAt: now, firstSeen: now, lastSeen: now, isActive: true, repostCount: 0, status: "active",
    invalidReason: null, invalidatedAt: null, canonicalId: null, dedupKey: "acme|software-engineer|remote:india_ok",
    ...over,
  };
}

describe("reposted dates can't make a job look newer (§3)", () => {
  it("a job can't be newer than when we first saw it", () => {
    const redated = { postedAt: new Date(Date.now() - 1 * DAY), firstSeen: new Date(Date.now() - 40 * DAY) };
    expect(Math.round(postingAgeDays(redated))).toBe(40);
  });

  it("id order exposes an old req re-stamped with today's date", () => {
    const bounds = idOrderPostedBounds(
      [
        { id: "900", date: iso(2) }, // new
        { id: "850", date: iso(95) },
        { id: "840", date: iso(90) },
        { id: "500", date: iso(1) }, // old id, fresh date → repost
      ],
      NOW,
    );
    expect(bounds.get("500")).toBe(iso(90)); // the SECOND-earliest newer date — robust to one outlier
    expect(bounds.has("900")).toBe(false);
  });

  it("ordinary approval lag (< 30 days) is left alone, and one mis-dated neighbour can't age a board", () => {
    const lag = idOrderPostedBounds([{ id: "20", date: iso(20) }, { id: "19", date: iso(21) }, { id: "10", date: iso(1) }], NOW);
    expect(lag.size).toBe(0);
    const outlier = idOrderPostedBounds([{ id: "20", date: iso(200) }, { id: "19", date: iso(3) }, { id: "10", date: iso(2) }], NOW);
    expect(outlier.size).toBe(0);
  });

  it("a dateless board dates jobs we watch appear, but not on its first poll", () => {
    const raws = [{ id: "301", raw: { postedAt: null } }, { id: "300", raw: { postedAt: null } }];
    expect(repostSafeDates("rippling", raws, new Map(), NOW).size).toBe(0);
    const stored = new Map([["300", { postedAt: null, firstSeen: iso(10) }]]);
    const dated = repostSafeDates("rippling", raws, stored, NOW);
    expect(dated.get("301")).toBe(new Date(NOW).toISOString());
    expect(dated.has("300")).toBe(false);
  });

  it("on an id-ordered board only a HIGHER id counts as newly appeared (a capped refresh isn't new)", () => {
    const stored = new Map([["500", { postedAt: null, firstSeen: iso(30) }]]);
    const dated = repostSafeDates(
      "atlassian",
      [{ id: "501", raw: { postedAt: null } }, { id: "400", raw: { postedAt: null } }, { id: "500", raw: { postedAt: null } }],
      stored,
      NOW,
    );
    expect(dated.get("501")).toBe(new Date(NOW).toISOString());
    expect(dated.has("400")).toBe(false);
  });

  it("no publish date at all reads as unknown age, not as new", () => {
    const dateless = scorePosting(posting({ postedAt: null, source: "greenhouse", atsType: "greenhouse" }), profile());
    const fresh = scorePosting(posting({ postedAt: new Date(), source: "greenhouse", atsType: "greenhouse" }), profile());
    expect(dateless.breakdown.freshness).toBeLessThanOrEqual(0.55);
    expect(fresh.breakdown.freshness).toBeGreaterThan(0.9);
  });
});

describe("AI-training gigs and talent pools (§11 trust)", () => {
  const mercorJd =
    "About the job Mercor connects elite creative and technical talent with leading AI research labs. Position: Backend Engineer " +
    "Type: Contract Compensation: $85/hour Location: Remote. Use frontier AI coding agents to complete and evaluate complex " +
    "engineering tasks. Review model-generated code for correctness, quality, maintainability and performance.";

  it("flags a known marketplace by name and a new brand by its pitch", () => {
    expect(isAiTrainingGig({ companyName: "mercor", jdText: "" })).toBe(true);
    expect(isAiTrainingGig({ companyName: "micro1", jdText: "" })).toBe(true);
    expect(isAiTrainingGig({ companyName: "NewLabelCo", jdText: mercorJd })).toBe(true);
  });

  it("an engineer at an AI company who evaluates model outputs on a salary is NOT a gig", () => {
    const jd = "We partner with leading AI labs. You'll build pipelines to evaluate model outputs at scale. Full-time, ₹30-45 LPA.";
    expect(isAiTrainingGig({ companyName: "Sarvam AI", jdText: jd })).toBe(false);
  });

  it("a gig is flagged, trusted less, and dampened like a non-target role — never hidden", () => {
    const gig = scorePosting(posting({ companyName: "mercor", jdText: mercorJd }), profile());
    const real = scorePosting(posting({ companyName: "Acme", jdText: "Build backend services in Python and Postgres." }), profile());
    expect(gig.flags.redFlags.join(" ")).toMatch(/AI-training gig/);
    expect(gig.breakdown.sourceTrust).toBeLessThan(real.breakdown.sourceTrust);
    expect(gig.score).toBeLessThan(real.score * 0.85);
    expect(gig.rulePass).toBe(true); // invariant #4: a weighted signal, not a hard filter
  });

  it("a structured 'posted by a consultancy' flag costs trust like the prose signals do", () => {
    const direct = scoreSourceTrust(posting({ source: "naukri" }));
    const agency = scoreSourceTrust(posting({ source: "naukri", postedByAgency: true }));
    expect(agency.score).toBeLessThan(direct.score);
    expect(agency.flags.join(" ")).toMatch(/staffing agency|consultancy/i);
  });

  it("a 'no immediate opening, send your CV for future consideration' JD reads as a talent pool", () => {
    const jd = "We value talented professionals, even when there may not be an immediate opening that matches their background.";
    const r = scorePosting(posting({ title: "L2 Anywhere in India", jdText: jd }), profile());
    expect(r.flags.redFlags.join(" ")).toMatch(/talent-pool|evergreen/i);
  });
});

describe("local embeddings carry their origin (embedding reuse)", () => {
  it("tags localEmbed output so a provider's silent fallback is keyed as local", () => {
    expect(embedOrigin(localEmbed("backend engineer"))).toBe(LOCAL_EMBEDDER_ID);
    expect(embedOrigin(localEmbed(""))).toBe(LOCAL_EMBEDDER_ID);
    expect(JSON.stringify(localEmbed("x")).includes("embedOrigin")).toBe(false); // never persisted
    expect(embedOrigin([0.1, 0.2])).toBeUndefined();
  });
});
