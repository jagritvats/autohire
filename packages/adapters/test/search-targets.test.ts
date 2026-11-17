import { describe, it, expect } from "vitest";
import { SearchQuery, type SearchQueryInput } from "@jobflow/core";
import { ADAPTERS, cloudAdapters, searchCapableAdapters } from "../src/registry.js";
import { buildIndiaSweTargets, buildTier3Targets, INDIA_SWE_QUERIES, INDIA_TECH_HUBS, tier3TargetsFromQuery } from "../src/tier3/targets.js";
import type { SearchTargetContext } from "../src/types.js";

const q = (input: SearchQueryInput) => SearchQuery.parse(input);
const IN: SearchTargetContext = { markets: ["IN"], yoe: 3 };
const US: SearchTargetContext = { markets: ["US"], yoe: 6 };
const DE: SearchTargetContext = { markets: ["DE"], yoe: 4 };

const targets = (source: string, query: SearchQueryInput, ctx: SearchTargetContext) => ADAPTERS[source]!.toTargets!(q(query), ctx);

describe("search-capable adapters (toTargets)", () => {
  it("every search-capable adapter is a cloud (tier 1-2) adapter with caps, ≤3 targets per query", () => {
    const capable = searchCapableAdapters();
    expect(capable.map((a) => a.source).sort()).toEqual(
      ["adzuna", "arbeitnow", "careerjet", "cutshort", "hirist", "himalayas", "hn_whoishiring", "instahyre", "jsearch", "remotive", "timesjobs", "wellfound"].sort(),
    );
    const big = q({ titles: ["a", "b", "c", "d"], keywords: ["e", "f"], locations: [{ city: null, country: "IN" }, { city: null, country: "US" }, { city: null, country: "DE" }], sources: ["jsearch"] });
    for (const a of capable) {
      expect(["tier1", "tier2"]).toContain(a.tier);
      expect(a.searchCaps).toBeDefined();
      expect(a.toTargets!(big, IN).length).toBeLessThanOrEqual(3);
    }
    expect(cloudAdapters().every((a) => a.tier !== "tier3")).toBe(true);
  });

  it("no terms → no targets", () => {
    for (const a of searchCapableAdapters()) expect(a.toTargets!(q({}), IN)).toEqual([]);
  });

  it("himalayas: term × country, seniority mapped, worldwide included; nothing for remote=exclude", () => {
    const t = targets("himalayas", { keywords: ["backend"], seniority: ["senior", "staff"] }, US);
    expect(t).toEqual([{ query: "backend", limit: 40, params: { country: "US", excludeWorldwide: false, seniority: "Senior" } }]);
    expect(targets("himalayas", { keywords: ["backend"], remote: "exclude" }, US)).toEqual([]);
    // no market at all → a worldwide search
    expect(targets("himalayas", { keywords: ["go"] }, { markets: [], yoe: 1 })[0]!.params!.country).toBe("");
  });

  it("remotive and hn: one target per term", () => {
    expect(targets("remotive", { titles: ["platform engineer"], keywords: ["go"] }, US)).toEqual([
      { query: "platform engineer", limit: 50 },
      { query: "go", limit: 50 },
    ]);
    expect(targets("hn_whoishiring", { keywords: ["rust"] }, US)).toEqual([{ query: "rust", limit: 60 }]);
  });

  it("arbeitnow only for European markets", () => {
    expect(targets("arbeitnow", { keywords: ["backend"] }, DE)).toEqual([{ query: "backend", limit: 60 }]);
    expect(targets("arbeitnow", { keywords: ["backend"] }, US)).toEqual([]);
    expect(targets("arbeitnow", { keywords: ["backend"], locations: [{ city: "Berlin", country: null }] }, US)).toHaveLength(1);
  });

  it("adzuna: country + city + max age; salary_min only when the currency is the country's", () => {
    const t = targets("adzuna", { keywords: ["backend"], locations: [{ city: "London", country: "GB" }], minSalary: { amount: 70_000, currency: "GBP" }, postedWithinDays: 7 }, US);
    expect(t).toEqual([{ query: "backend", limit: 50, location: "London", params: { country: "gb", maxDaysOld: 7, salaryMin: 70_000 } }]);
    const usd = targets("adzuna", { keywords: ["backend"], locations: [{ city: null, country: "GB" }], minSalary: { amount: 90_000, currency: "USD" } }, US);
    expect(usd[0]!.params!.salaryMin).toBeUndefined();
    expect(targets("adzuna", { keywords: ["x"] }, { markets: ["KE"], yoe: 1 })).toEqual([]); // country Adzuna doesn't serve
  });

  it("careerjet: the locale follows the country", () => {
    expect(targets("careerjet", { keywords: ["backend"] }, US)[0]!.params).toEqual({ locale: "en_US" });
    expect(targets("careerjet", { keywords: ["backend"] }, DE)[0]!.params).toEqual({ locale: "de_DE" });
    expect(targets("careerjet", { keywords: ["backend"] }, IN)[0]!.params).toEqual({ locale: "en_IN" });
  });

  it("jsearch (paid) only when the query names it, and then one target", () => {
    expect(targets("jsearch", { keywords: ["backend", "go"] }, US)).toEqual([]);
    const t = targets("jsearch", { keywords: ["backend", "go"], sources: ["jsearch"], remote: "only", postedWithinDays: 3 }, US);
    expect(t).toEqual([{ query: "backend", limit: 30, location: "United States", params: { datePosted: "3days", country: "us", remoteOnly: true } }]);
  });

  it("India boards only for India", () => {
    for (const s of ["hirist", "timesjobs", "instahyre", "cutshort"]) {
      expect(targets(s, { keywords: ["backend developer"] }, US)).toEqual([]);
      expect(targets(s, { keywords: ["backend developer"] }, IN).length).toBeGreaterThan(0);
    }
    expect(targets("hirist", { keywords: ["java"] }, IN)).toEqual([{ query: "java", limit: 60, params: { minexp: 2, maxexp: 5 } }]);
    expect(targets("timesjobs", { keywords: ["java"], locations: [{ city: "Pune", country: "IN" }] }, IN)).toEqual([
      { query: "java", limit: 60, params: { experience: 3, locations: "Pune" } },
    ]);
  });

  it("cutshort: verified city slugs only", () => {
    expect(targets("cutshort", { keywords: ["backend developer"], locations: [{ city: "Bangalore", country: "IN" }] }, IN)).toEqual([
      { query: "backend-developer-jobs-in-bangalore-bengaluru", limit: 50 },
    ]);
    expect(targets("cutshort", { keywords: ["backend developer"], locations: [{ city: "Indore", country: "IN" }] }, IN)).toEqual([]);
    expect(targets("cutshort", { keywords: ["backend developer"] }, IN).map((t) => t.query)).toEqual([
      "backend-developer-jobs-in-bangalore-bengaluru",
      "backend-developer-jobs-in-pune",
      "backend-developer-jobs-in-hyderabad",
    ]);
  });

  it("wellfound: role slug × place slug, remote-only → 'remote'", () => {
    expect(targets("wellfound", { keywords: ["Backend Engineer"] }, US)).toEqual([
      { query: "backend-engineer", limit: 60, params: { location: "united-states", maxPages: 2 } },
    ]);
    expect(targets("wellfound", { keywords: ["backend engineer"], remote: "only" }, IN)[0]!.params!.location).toBe("remote");
  });
});

describe("Tier-3 targets (local agent only — pure planning)", () => {
  it("buildIndiaSweTargets is buildTier3Targets with the India hubs/queries (identical output)", () => {
    for (const opts of [{}, { minLpa: 20, maxTargets: 6 }, { queries: ["staff engineer"], locations: ["bengaluru"], remote: false }, { experienceYears: 3, maxTargets: 20 }]) {
      expect(buildIndiaSweTargets(opts)).toEqual(
        buildTier3Targets({ ...opts, hubs: (opts as { locations?: string[] }).locations ?? [...INDIA_TECH_HUBS], queries: (opts as { queries?: string[] }).queries ?? [...INDIA_SWE_QUERIES] }),
      );
    }
    expect(buildIndiaSweTargets()).toHaveLength(8);
  });

  it("tier3TargetsFromQuery maps a search onto ≤3 cells", () => {
    const t = tier3TargetsFromQuery(q({ keywords: ["backend engineer"], locations: [{ city: "Pune", country: "IN" }], minSalary: { amount: 3_000_000, currency: "INR" } }), IN);
    expect(t.length).toBeLessThanOrEqual(3);
    expect(t.map((x) => x.location)).toEqual(["", "pune"]);
    expect(t[0]!.minLpa).toBe(30);
    expect(tier3TargetsFromQuery(q({ keywords: ["x"], remote: "only" }), IN).map((x) => x.location)).toEqual([""]);
    expect(tier3TargetsFromQuery(q({ keywords: ["x"], remote: "exclude" }), US)).toEqual([]);
    expect(tier3TargetsFromQuery(q({}), IN)).toEqual([]);
  });

  it("no Tier-3 adapter is registered in the cloud registry", () => {
    for (const s of ["naukri", "linkedin", "glassdoor", "ambitionbox", "darwinbox", "peerlist"]) expect(ADAPTERS[s]).toBeUndefined();
  });
});
