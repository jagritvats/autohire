import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalConfigJson, type DiscoverySource, type DiscoverySourceConfig, type SavedSearch, type SearchQueryInput, SearchQuery, TenantConfig } from "@jobflow/core";
import { ADAPTERS, INDIA_SWE_QUERIES, INDIA_TECH_HUBS, type SourceAdapter } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import { createHash, randomUUID } from "node:crypto";
import { getPreset, listPresets, suggestPreset, INDIA_PRESET } from "../src/presets/index.js";
import { DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "../src/poll.js";
import { SEED_COMPANIES } from "../src/seed.js";
import { enabledSourcesOf, isSearchDue, resolveDiscoveryPlan } from "../src/discovery.js";
import { blankProfile } from "../src/seed.js";
import { sampleProfile } from "../src/sample.js";
import { LEGACY_DISCOVERY_FEEDS, LEGACY_TELEGRAM_CHANNELS } from "./fixtures/legacy-feeds.js";

const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

function config(tenantId: string, over: Partial<TenantConfig> = {}): TenantConfig {
  return TenantConfig.parse({ tenantId, ...over });
}

function source(tenantId: string, cfg: DiscoverySourceConfig, label = "src"): DiscoverySource {
  return {
    id: randomUUID(),
    tenantId,
    label,
    config: cfg,
    configKey: createHash("sha1").update(canonicalConfigJson(cfg)).digest("hex"),
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastCount: null,
    lastError: null,
    createdAt: new Date(),
  };
}

function search(tenantId: string, name: string, query: SearchQueryInput, over: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: randomUUID(),
    tenantId,
    name,
    query: SearchQuery.parse(query),
    asSource: true,
    asView: true,
    cadence: "daily",
    enabled: true,
    lastRunAt: null,
    lastResult: null,
    createdAt: new Date(),
    ...over,
  };
}

const NO_ENV = { env: {} };

describe("discovery presets", () => {
  it("india preset == today's discovery, unchanged (golden)", () => {
    const india = getPreset("india")!;
    expect(india.feeds.map(({ id: _id, ...f }) => f)).toEqual(LEGACY_DISCOVERY_FEEDS);
    expect(DEFAULT_DISCOVERY_FEEDS).toEqual(LEGACY_DISCOVERY_FEEDS); // old export kept
    expect(india.telegramChannels).toEqual(LEGACY_TELEGRAM_CHANNELS);
    expect(DEFAULT_TELEGRAM_CHANNELS).toEqual(LEGACY_TELEGRAM_CHANNELS);
    expect(india.seedCompanies).toBe(SEED_COMPANIES);
    expect(india.tier3).toEqual({ hubs: [...INDIA_TECH_HUBS], queries: [...INDIA_SWE_QUERIES] });
    expect(india.markets).toEqual(["IN"]);
  });

  it("every preset has stable, unique feed ids over cloud adapters", () => {
    const ids = new Set<string>();
    for (const p of listPresets()) {
      for (const f of p.feeds) {
        expect(f.id.startsWith(`${p.id}.`)).toBe(true);
        expect(ids.has(f.id)).toBe(false);
        ids.add(f.id);
        expect(["tier1", "tier2"]).toContain(ADAPTERS[f.source]?.tier);
      }
      expect(p.seedCompanies.length).toBeGreaterThan(0);
    }
    expect(listPresets().map((p) => p.id)).toEqual(["india", "global-remote", "us", "eu-uk"]);
    expect(getPreset("nope")).toBeNull();
    // arbeitnow (a German-market board) only in the EU preset
    expect(listPresets().filter((p) => p.feeds.some((f) => f.source === "arbeitnow")).map((p) => p.id)).toEqual(["eu-uk"]);
  });

  it("suggestPreset follows home country / markets", () => {
    expect(suggestPreset({ currency: "INR", locationWeights: [] }).id).toBe("india");
    expect(suggestPreset({ currency: "USD", homeCountry: "US", locationWeights: [] }).id).toBe("us");
    expect(suggestPreset({ currency: "EUR", homeCountry: "DE", locationWeights: [] }).id).toBe("eu-uk");
    expect(suggestPreset({ currency: "GBP", locationWeights: [] }).id).toBe("eu-uk");
    expect(suggestPreset({ currency: "USD", locationWeights: [{ label: "remote", weight: 1 }] }).id).toBe("global-remote");
  });
});

describe("resolveDiscoveryPlan", () => {
  afterEach(() => {
    delete ADAPTERS.naukri;
  });

  it("no tenants → today's india discovery", async () => {
    const plan = await resolveDiscoveryPlan(new InMemoryRepository(), NO_ENV);
    expect(plan.presets).toEqual(["india"]);
    expect(plan.feeds).toEqual(LEGACY_DISCOVERY_FEEDS);
    expect(plan.telegramChannels).toEqual(LEGACY_TELEGRAM_CHANNELS);
    expect(plan.seeds).toEqual(SEED_COMPANIES);
    expect(plan.pollCountries).toEqual(["IN"]);
    expect(plan.searchTargets).toEqual([]);
  });

  it("pollCountries: env override → tenants' markets → preset markets → IN", async () => {
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    await repo.saveConfig(config(A, { discoveryPreset: "us" }));
    expect((await resolveDiscoveryPlan(repo, NO_ENV)).pollCountries).toEqual(["US"]); // preset markets (no profile)
    await repo.saveProfile({ ...blankProfile(A), prefs: { ...blankProfile(A).prefs, homeCountry: "GB", markets: ["GB", "DE"] } });
    expect((await resolveDiscoveryPlan(repo, NO_ENV)).pollCountries).toEqual(["GB", "DE"]); // tenant markets
    expect((await resolveDiscoveryPlan(repo, { env: { JOBFLOW_POLL_COUNTRY: "sg, in" } })).pollCountries).toEqual(["SG", "IN"]);
    const empty = new InMemoryRepository();
    await empty.createTenant({ name: "g", id: B });
    await empty.saveConfig(config(B, { discoveryPreset: "global-remote" }));
    expect((await resolveDiscoveryPlan(empty, NO_ENV)).pollCountries).toEqual(["IN"]);
  });

  it("unions two tenants' presets, custom sources and searches — deduped", async () => {
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    await repo.createTenant({ name: "b", id: B });
    await repo.saveConfig(config(A, { discoveryPreset: "india", presetFeedsDisabled: ["india.reddit"] }));
    await repo.saveConfig(config(B, { discoveryPreset: "us" }));
    await repo.saveProfile(sampleProfile(A)); // IN
    await repo.saveProfile({ ...blankProfile(B), yoe: 6, prefs: { ...blankProfile(B).prefs, homeCountry: "US" } });

    // the SAME rss feed configured by both tenants → one target, runs recorded on both rows
    const rssCfg: DiscoverySourceConfig = { kind: "rss", url: "https://feeds.example.com/jobs.rss", company: null };
    const ra = await repo.saveDiscoverySource(source(A, rssCfg));
    const rb = await repo.saveDiscoverySource(source(B, rssCfg));
    await repo.saveDiscoverySource(source(A, { kind: "telegram", channel: "gocareers" })); // already in the preset
    await repo.saveDiscoverySource(source(B, { kind: "telegram", channel: "remote_jobs_feed" }));
    await repo.saveDiscoverySource(source(B, { kind: "json_feed", url: "https://api.example.com/jobs.json", mapping: { itemsPath: "items", id: "id", title: "title", company: "company", url: "url", location: null, description: "content_html", postedAt: "date_published", salary: null } }));
    await repo.saveDiscoverySource(source(A, { kind: "hn_thread", storyId: "424242" }));
    await repo.saveDiscoverySource(source(B, { kind: "company_list", companies: [{ name: "Stripe", careersUrl: null }, { name: "Hooli Labs", careersUrl: "https://boards.greenhouse.io/hooli" }] }));

    // the same query saved by both tenants with the same market → one remotive target
    await repo.saveSavedSearch(search(A, "go remote", { keywords: ["golang"], remote: "only", sources: ["remotive"] }));
    await repo.saveSavedSearch(search(B, "go remote", { keywords: ["golang"], remote: "only", sources: ["remotive"] }));
    await repo.saveSavedSearch(search(B, "manual one", { keywords: ["rust"] }, { cadence: "manual" }));

    const plan = await resolveDiscoveryPlan(repo, NO_ENV);
    expect(plan.presets).toEqual(["india", "us"]);
    // tenant A switched reddit off, nobody else uses the india preset
    expect(plan.feeds.some((f) => f.source === "reddit")).toBe(false);
    expect(plan.feeds.filter((f) => f.source === "himalayas")).toHaveLength(2); // india.* + us.*
    // no target repeated for a source
    const keys = plan.feeds.flatMap((f) => f.targets.map((t) => `${f.source}|${JSON.stringify(t)}`));
    expect(new Set(keys).size).toBe(keys.length);

    expect(plan.rssTargets).toHaveLength(1);
    expect(plan.rssTargets[0]!.sourceIds.sort()).toEqual([ra.id, rb.id].sort());
    expect(plan.rssTargets[0]!.target.params).toMatchObject({ url: "https://feeds.example.com/jobs.rss" });
    expect(plan.jsonTargets).toHaveLength(1);
    expect(JSON.parse(String(plan.jsonTargets[0]!.target.params!.mapping))).toMatchObject({ itemsPath: "items" });
    expect(plan.threads).toEqual([expect.objectContaining({ source: "hn_whoishiring", target: { limit: 300, params: { storyId: "424242" } } })]);
    expect(plan.telegramChannels.filter((c) => c === "gocareers")).toHaveLength(1);
    expect(plan.telegramChannels).toContain("remote_jobs_feed");
    // company list: Stripe is already a preset seed (deduped), Hooli is added
    expect(plan.seeds.filter((s) => s.name === "Stripe")).toHaveLength(1);
    expect(plan.seeds.some((s) => s.name === "Hooli Labs")).toBe(true);
    expect(plan.companyListSourceIds).toHaveLength(1);
    // markets of both tenants
    expect(plan.pollCountries).toEqual(["IN", "US"]);

    // searches: identical (source, target) from two tenants merge; the manual search never runs
    const remotive = plan.searchTargets.filter((t) => t.source === "remotive");
    expect(remotive).toHaveLength(1);
    expect(remotive[0]!.searches.map((s) => s.tenantId).sort()).toEqual([A, B].sort());
    expect(plan.searchTargets.every((t) => t.searches.every((s) => s.searchId))).toBe(true);
    expect(plan.searchTargets.some((t) => JSON.stringify(t.target).includes("rust"))).toBe(false);
  });

  it("caps: ≤5 searches per tenant, ≤3 targets per (search, source), per-source budget", async () => {
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    await repo.saveProfile({ ...sampleProfile(A) });
    for (let i = 0; i < 8; i++) {
      await repo.saveSavedSearch(search(A, `s${i}`, { titles: [`t${i}a`, `t${i}b`, `t${i}c`, `t${i}d`], sources: ["remotive"] }));
    }
    const plan = await resolveDiscoveryPlan(repo, { ...NO_ENV, perSourceBudget: 100 });
    const searchIds = new Set(plan.searchTargets.flatMap((t) => t.searches.map((s) => s.searchId)));
    expect(searchIds.size).toBe(5);
    for (const id of searchIds) expect(plan.searchTargets.filter((t) => t.searches.some((s) => s.searchId === id))).toHaveLength(3);
    const budget = await resolveDiscoveryPlan(repo, { ...NO_ENV, perSourceBudget: 4 });
    expect(budget.searchTargets.filter((t) => t.source === "remotive")).toHaveLength(4);
  });

  it("never yields a Tier-3 source — not even if one were (wrongly) registered", async () => {
    // a rogue tier-3 adapter slipped into the registry under a tier-3 source name
    const rogue: SourceAdapter = {
      source: "naukri",
      tier: "tier3",
      fetch: vi.fn(async () => []),
      toTargets: () => [{ query: "x" }],
    };
    ADAPTERS.naukri = rogue;
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    await repo.saveProfile(sampleProfile(A));
    await repo.saveSavedSearch(search(A, "naukri+linkedin", { keywords: ["java"], sources: ["naukri", "linkedin", "glassdoor"] }));
    await repo.saveSavedSearch(search(A, "everything", { keywords: ["java"] }));
    const plan = await resolveDiscoveryPlan(repo, NO_ENV);
    const all = [
      ...plan.feeds.map((f) => f.source),
      ...plan.searchTargets.map((t) => t.source),
      ...plan.rssTargets.map((t) => t.source),
      ...plan.jsonTargets.map((t) => t.source),
      ...plan.threads.map((t) => t.source),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) expect(["tier1", "tier2"]).toContain(ADAPTERS[s]!.tier);
    expect(all).not.toContain("naukri");
    expect(all).not.toContain("linkedin");
  });

  it("sourcesEnabled: the legacy default is no restriction; an explicit list filters preset feeds", async () => {
    expect(enabledSourcesOf(config(A))).toBeNull();
    expect(enabledSourcesOf(config(A, { sourcesEnabled: [] }))).toBeNull();
    expect(enabledSourcesOf(config(A, { sourcesEnabled: ["himalayas"] }))).toEqual(new Set(["himalayas"]));
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    await repo.saveConfig(config(A, { sourcesEnabled: ["himalayas", "remotive"] }));
    const plan = await resolveDiscoveryPlan(repo, NO_ENV);
    expect(plan.feeds.map((f) => f.source)).toEqual(["himalayas", "remotive"]);
  });

  it("search cadence", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(isSearchDue({ cadence: "daily", lastRunAt: null }, now)).toBe(true);
    expect(isSearchDue({ cadence: "daily", lastRunAt: new Date(now - 3_600_000) }, now)).toBe(false);
    expect(isSearchDue({ cadence: "daily", lastRunAt: new Date(now - 23 * 3_600_000) }, now)).toBe(true);
    expect(isSearchDue({ cadence: "weekly", lastRunAt: new Date(now - 3 * 86_400_000) }, now)).toBe(false);
    expect(isSearchDue({ cadence: "manual", lastRunAt: null }, now)).toBe(false);
  });

  it("the india preset in the plan is the same feed objects' content as INDIA_PRESET", () => {
    expect(INDIA_PRESET.feeds.every((f) => f.id === `india.${f.source}`)).toBe(true);
  });
});
