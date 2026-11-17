import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { TenantConfig, activePresets, applyView, SearchQuery, type Posting } from "@jobflow/core";
import { DEFAULT_TENANT } from "../src/seed.js";
import { resolveDiscoveryPlan } from "../src/discovery.js";
import { getPreset, presetFeedSources, presetsForPosting } from "../src/presets/index.js";
import { makeSearchQuery } from "../src/search.js";

const cfg = (over: Partial<TenantConfig>) => TenantConfig.parse({ tenantId: DEFAULT_TENANT, ...over });

describe("multi-select presets", () => {
  it("activePresets prefers the list, falls back to the legacy single preset", () => {
    expect(activePresets(cfg({ discoveryPresets: ["us", "eu-uk"] }))).toEqual(["us", "eu-uk"]);
    expect(activePresets(cfg({ discoveryPreset: "us" }))).toEqual(["us"]);
    expect(activePresets(null)).toEqual(["india"]);
  });

  it("the discovery plan unions every preset a tenant switched on", async () => {
    const repo = new InMemoryRepository();
    await repo.saveConfig(cfg({ discoveryPresets: ["us", "eu-uk"] }));
    const plan = await resolveDiscoveryPlan(repo, { env: {} });
    expect(plan.presets.sort()).toEqual(["eu-uk", "us"]);
    const usSeed = getPreset("us")!.seedCompanies[0]!.name;
    const euSeed = getPreset("eu-uk")!.seedCompanies[0]!.name;
    expect(plan.seeds.some((s) => s.name === usSeed)).toBe(true);
    expect(plan.seeds.some((s) => s.name === euSeed)).toBe(true);
  });
});

describe("presets as search / feed tags", () => {
  const posting = (over: Partial<Posting>) =>
    ({
      companyName: "Nobody Inc",
      source: "greenhouse",
      title: "Engineer",
      jdSkills: [],
      levelBand: null,
      location: { mode: "unknown", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0 },
      salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
      postedAt: null,
      firstSeen: new Date(),
      ...over,
    }) as unknown as Posting;

  it("tags a posting by its company (preset seed list) or its feed source", () => {
    const indiaCo = getPreset("india")!.seedCompanies[0]!.name;
    expect(presetsForPosting(posting({ companyName: indiaCo }))).toContain("india");
    expect(presetsForPosting(posting({ source: "hirist" }))).toContain("india");
    expect(presetsForPosting(posting({}))).toEqual([]);
    // a feed every preset shares tags by fit, not all four
    const hn = (location: Partial<Posting["location"]>) =>
      presetsForPosting(posting({ source: "hn_whoishiring", location: { ...posting({}).location, ...location } as Posting["location"] }));
    expect(hn({ mode: "onsite", city: "Bengaluru", country: "India", confidence: 0.9 })).toContain("india");
    expect(hn({ mode: "onsite", city: "Bengaluru", country: "India", confidence: 0.9 })).not.toContain("us");
    expect(hn({ mode: "remote", remoteGeo: "worldwide", confidence: 0.9 })).toContain("global-remote");
  });

  it("--preset parses into query.presets; a preset search asks that preset's feeds", () => {
    const q = makeSearchQuery("backend --preset us,EU-UK --remote");
    expect(q.presets).toEqual(["us", "eu-uk"]);
    expect(q.keywords.join(" ")).toContain("backend");
    expect(presetFeedSources(["india"])).toContain("hirist");
  });

  it("the view hides postings outside the chosen presets, counted under 'preset'", () => {
    const indiaCo = getPreset("india")!.seedCompanies[0]!.name;
    const items = [{ posting: posting({ companyName: indiaCo }) }, { posting: posting({}) }];
    const v = applyView(items, SearchQuery.parse({ presets: ["india"] }), { presetsOf: presetsForPosting });
    expect(v.shown).toHaveLength(1);
    expect(v.hidden.preset).toBe(1);
  });
});
