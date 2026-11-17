import { describe, it, expect } from "vitest";
import { applyView, scorePosting, searchRelevance, viewHideReason } from "../src/match/index.js";
import { SearchQuery, type ParsedLocation, type Posting, type Profile } from "../src/schema/index.js";

const NOW = Date.parse("2026-11-17T00:00:00Z");
const DAY = 86_400_000;

const loc = (over: Partial<ParsedLocation> = {}): ParsedLocation => ({
  mode: "onsite",
  city: "Berlin",
  country: "Europe",
  timezone: null,
  remoteGeo: "unknown",
  sponsorship: null,
  confidence: 0.85,
  ...over,
});

let n = 0;
function posting(over: Partial<Posting> = {}): Posting {
  n++;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    companyId: "c1",
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: String(n),
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "backend-engineer",
    roleArchetype: "backend",
    levelBand: "senior",
    jdText: "We build services in Go and Postgres.",
    jdSkills: ["go", "postgres"],
    requirements: [],
    location: loc(),
    salary: { min: null, max: null, currency: "EUR", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: null,
    jdEmbedding: null,
    postedAt: new Date(NOW - 2 * DAY).toISOString(),
    firstSeen: new Date(NOW - 2 * DAY).toISOString(),
    lastSeen: new Date(NOW).toISOString(),
    isActive: true,
    repostCount: 0,
    status: "active",
    invalidReason: null,
    invalidatedAt: null,
    canonicalId: null,
    dedupKey: `acme|${n}`,
    ...over,
  };
}

const profile: Profile = {
  id: "p1",
  tenantId: "t1",
  masterResume: "",
  resumeLatex: "",
  aboutText: "",
  profileEmbedding: null,
  yoe: 5,
  levelBand: "senior",
  onboardedAt: null,
  resumeFile: null,
  prefs: {
    salaryFloor: 0,
    currency: "EUR",
    homeCountry: "DE",
    markets: [],
    contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
    locationWeights: [{ label: "remote", weight: 1 }],
    stackMustHaves: [],
    stackProfile: ["go", "postgres"],
    remoteGeoOk: ["worldwide", "eu_only"],
    relocate: false,
    targetArchetypes: ["backend"],
  },
};

const wrap = (p: Posting) => ({ posting: p, match: scorePosting(p, profile) });

describe("applyView — hides only confidently-known values, counts every hide", () => {
  it("unknown values always pass", () => {
    const q = SearchQuery.parse({
      locations: [{ city: "Berlin", country: "DE" }],
      remote: "only",
      seniority: ["staff"],
      minSalary: { amount: 100_000, currency: "EUR" },
      postedWithinDays: 7,
      mustSkills: ["rust"],
    });
    const unknowns = [
      posting({ location: loc({ city: "Munich", confidence: 0.45 }), levelBand: null, jdSkills: [] }), // low-confidence place, no band, no parsed skills
      posting({ location: loc({ mode: "unknown", city: null, country: null, confidence: 0.2 }), levelBand: null, jdSkills: [] }),
      posting({ levelBand: null, jdSkills: [], location: loc({ mode: "remote", remoteGeo: "unknown", city: null, country: null, confidence: 0.35 }) }),
      // salary stated but low confidence / no ceiling; no parsed skills
      posting({
        levelBand: null,
        location: loc({ mode: "remote", city: null, country: null, remoteGeo: "eu_only", confidence: 0.9 }),
        salary: { min: 50_000, max: null, currency: "EUR", source: "jd_direct", confidence: "high" },
        jdSkills: [],
      }),
    ];
    const view = applyView(unknowns.map(wrap), q, { now: NOW });
    expect(view.hiddenTotal).toBe(0);
    expect(view.shown).toHaveLength(unknowns.length);
  });

  it("counts each hidden match under exactly one (the first failing) reason", () => {
    const q = SearchQuery.parse({
      locations: [{ city: "Berlin", country: "DE" }],
      remote: "any",
      seniority: ["senior"],
      minSalary: { amount: 80_000, currency: "EUR" },
      postedWithinDays: 14,
      mustSkills: ["go"],
      niceSkills: ["kubernetes"],
      excludeCompanies: ["Evil Corp"],
      excludeKeywords: ["crypto"],
    });
    const items = [
      posting(), // passes
      posting({ jdSkills: ["go", "postgres"], title: "Backend Engineer" }), // passes (nice skill missing never hides)
      posting({ companyName: "Evil Corp Inc." }), // company
      posting({ companyName: "Evil Corp", title: "Crypto Backend Engineer" }), // company (first reason wins)
      posting({ title: "Crypto Backend Engineer" }), // keyword
      posting({ location: loc({ city: "Bengaluru", country: "India", confidence: 0.85 }) }), // location
      posting({ location: loc({ city: "Munich", country: "Europe", confidence: 0.85 }) }), // location (city mismatch)
      posting({ location: loc({ mode: "remote", city: null, country: null, remoteGeo: "us_only", confidence: 0.9 }) }), // location (remote not open to DE)
      posting({ levelBand: "junior" }), // seniority
      posting({ salary: { min: 40_000, max: 60_000, currency: "EUR", source: "jd_direct", confidence: "high" } }), // salary
      posting({ postedAt: new Date(NOW - 40 * DAY).toISOString(), firstSeen: new Date(NOW - 40 * DAY).toISOString() }), // age
      posting({ jdSkills: ["java"], jdText: "Java and Spring." }), // skill
    ];
    const matches = items.map(wrap);
    const view = applyView(matches, q, { now: NOW });
    expect(view.hidden).toEqual({ company: 2, keyword: 1, location: 3, remote: 0, seniority: 1, salary: 1, age: 1, skill: 1 });
    expect(view.hiddenTotal).toBe(10);
    expect(view.shown.map((m) => m.posting.id)).toEqual([items[0]!.id, items[1]!.id]);
    expect(Object.values(view.hidden).reduce((a, b) => a + b, 0)).toBe(view.hiddenTotal);
  });

  it("remote only / exclude / remote-geo hide only with confidence ≥ 0.85", () => {
    const onsite = posting({ location: loc({ confidence: 0.85 }) });
    const onsiteUnsure = posting({ location: loc({ confidence: 0.7 }) });
    const remoteEu = posting({ location: loc({ mode: "remote", city: null, country: null, remoteGeo: "eu_only", confidence: 0.9 }) });
    const remoteUs = posting({ location: loc({ mode: "remote", city: null, country: null, remoteGeo: "us_only", confidence: 0.9 }) });
    const all = [onsite, onsiteUnsure, remoteEu, remoteUs].map(wrap);
    expect(applyView(all, { remote: "only" }, { now: NOW }).hidden.remote).toBe(1);
    expect(applyView(all, { remote: "exclude" }, { now: NOW }).hidden.remote).toBe(2);
    expect(applyView(all, { remoteGeo: ["eu_only", "worldwide"] }, { now: NOW }).hidden.remote).toBe(1);
  });

  it("never rescored, never mutated — scores are untouched and order preserved", () => {
    const items = [posting(), posting({ levelBand: "junior" }), posting({ title: "Staff Backend Engineer", levelBand: "staff" })];
    const matches = items.map(wrap);
    const before = JSON.parse(JSON.stringify(matches));
    const view = applyView(matches, { seniority: ["senior", "staff"] }, { now: NOW });
    expect(JSON.parse(JSON.stringify(matches))).toEqual(before);
    expect(view.shown.map((m) => m.match.score)).toEqual([matches[0]!.match.score, matches[2]!.match.score]);
    for (const m of view.shown) expect(m).toBe(matches.find((x) => x.posting.id === m.posting.id));
    // the scorer gives the same score with or without a view
    for (const m of matches) expect(scorePosting(m.posting, profile).score).toBe(m.match.score);
  });

  it("an empty query hides nothing", () => {
    const items = [posting(), posting({ levelBand: null })].map(wrap);
    const view = applyView(items, {}, { now: NOW });
    expect(view.hiddenTotal).toBe(0);
    expect(view.shown).toHaveLength(2);
  });

  it("salary in another currency is never compared (no FX at a view gate)", () => {
    const p = posting({ salary: { min: 10, max: 20, currency: "USD", source: "jd_direct", confidence: "high" } });
    expect(viewHideReason(p, SearchQuery.parse({ minSalary: { amount: 80_000, currency: "EUR" } }), { now: NOW })).toBeNull();
  });
});

describe("searchRelevance", () => {
  it("rewards title/keyword and skill hits, in [0,1]", () => {
    const q = { keywords: ["backend"], mustSkills: ["go"], niceSkills: ["kubernetes"] };
    const good = searchRelevance(posting(), q);
    const bad = searchRelevance(posting({ title: "Data Analyst", jdText: "Excel", jdSkills: [] }), q);
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeLessThanOrEqual(1);
    expect(bad).toBeGreaterThanOrEqual(0);
    expect(searchRelevance(posting(), {})).toBe(0.5);
  });
});
