import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProfilePrefs,
  type DiscoverySource,
  type Evidence,
  type Match,
  type Profile,
  type SavedSearch,
  type TenantConfig,
} from "@jobflow/core";
import { InMemoryRepository } from "../src/memory.js";
import { openPglite } from "../src/pglite.js";
import { PgRepository } from "../src/postgres.js";
import type { NewPosting, Repository } from "../src/repository.js";

/**
 * One behavioural contract, run against every Repository implementation: the in-memory
 * repo (dev/tests) and PgRepository on PGlite (the same SQL the Postgres server runs).
 * Each test makes its own tenants, so the suites share one database per store.
 */
interface Store {
  repo: Repository;
  close(): Promise<void>;
}

const stores: Array<[string, () => Promise<Store>]> = [
  ["memory", async () => ({ repo: new InMemoryRepository(), close: async () => {} })],
  [
    "pglite",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "jobflow-contract-"));
      const repo = new PgRepository(await openPglite(dir));
      return {
        repo,
        close: async () => {
          await repo.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

const iso = (d: unknown) => (d == null ? null : new Date(d as string | Date).toISOString());
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function profileFor(tenantId: string, over: Partial<Profile> = {}): Profile {
  return {
    id: randomUUID(),
    tenantId,
    masterResume: "",
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 0,
    levelBand: "mid",
    prefs: ProfilePrefs.parse({}),
    onboardedAt: null,
    resumeFile: null,
    ...over,
  };
}

function evidenceFor(tenantId: string, over: Partial<Evidence> = {}): Evidence {
  return {
    id: randomUUID(),
    tenantId,
    project: "Ledger",
    headline: "Cut p99 latency",
    detail: "Rewrote the hot path",
    metric: "-40%",
    tags: ["go"],
    embedding: null,
    origin: "manual",
    ...over,
  };
}

function configFor(tenantId: string, over: Partial<TenantConfig> = {}): TenantConfig {
  return {
    tenantId,
    sourcesEnabled: ["greenhouse", "lever"],
    automationFlags: { browser: "off", mode: "capture", autosubmit: false, rate: "human", tier3Sources: [] },
    llmChoice: "anthropic",
    llmModel: "",
    llmApiKey: "sk-test-123",
    llmBaseUrl: "",
    digestCadence: "daily",
    discoveryPreset: "india",
    presetFeedsDisabled: [],
    ...over,
  };
}

function searchFor(tenantId: string, name: string, over: Partial<SavedSearch> = {}): SavedSearch {
  return {
    id: randomUUID(),
    tenantId,
    name,
    query: {
      keywords: ["rust"],
      titles: [],
      mustSkills: [],
      niceSkills: [],
      locations: [],
      remote: "any",
      remoteGeo: [],
      seniority: [],
      minSalary: null,
      postedWithinDays: null,
      sources: [],
      excludeCompanies: [],
      excludeKeywords: [],
    },
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

function sourceFor(tenantId: string, configKey: string, over: Partial<DiscoverySource> = {}): DiscoverySource {
  return {
    id: randomUUID(),
    tenantId,
    label: "Feed",
    config: { kind: "rss", url: `https://example.com/${configKey}.xml`, company: null },
    configKey,
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastCount: null,
    lastError: null,
    createdAt: new Date(),
    ...over,
  };
}

function postingFor(companyId: string, over: Partial<NewPosting> = {}): NewPosting {
  return {
    companyId,
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: randomUUID(),
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "backend-engineer",
    roleArchetype: "backend",
    levelBand: "mid",
    jdText: "build things",
    jdSkills: ["go"],
    requirements: [],
    location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
    salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: null,
    jdEmbedding: null,
    dedupKey: `acme|backend|${randomUUID()}`,
    ...over,
  };
}

describe.each(stores)("Repository contract — %s", (name, open) => {
  let store: Store;
  let repo: Repository;
  beforeAll(async () => {
    store = await open();
    repo = store.repo;
  }, 120_000);
  afterAll(async () => {
    await store?.close();
  });

  const newTenant = async (label = "t") => (await repo.createTenant({ name: label })).id;

  // ── tenants + accounts ──
  it("createTenant with an explicit id is idempotent; listTenants counts never-active tenants", async () => {
    const id = randomUUID();
    const a = await repo.createTenant({ name: "first", id });
    const b = await repo.createTenant({ name: "second", id });
    expect(b.id).toBe(id);
    expect(b.name).toBe("first");
    expect(a.lastActiveAt).toBeNull();
    expect((await repo.getTenant(id))?.name).toBe("first");

    const active = await repo.listTenants({ activeSinceDays: 7 });
    expect(active.map((t) => t.id)).toContain(id); // never marked active → counted
    await repo.touchTenantActive(id);
    const touched = await repo.getTenant(id);
    expect(touched?.lastActiveAt).not.toBeNull();
    expect((await repo.listTenants({ activeSinceDays: 7 })).map((t) => t.id)).toContain(id);
    expect((await repo.listTenants()).map((t) => t.id)).toContain(id);
  });

  it("users: emails are unique case-insensitively; only findUserByEmail exposes the hash", async () => {
    const t = await newTenant();
    const before = await repo.countUsers();
    const email = `Someone.${randomUUID().slice(0, 8)}@Example.com`;
    const u = await repo.createUser({ tenantId: t, email, passwordHash: "scrypt$hash", role: "admin" });
    expect(u.email).toBe(email.toLowerCase());
    expect(u.role).toBe("admin");
    expect("passwordHash" in u).toBe(false);
    expect(await repo.countUsers()).toBe(before + 1);

    await expect(repo.createUser({ tenantId: t, email: email.toUpperCase(), passwordHash: null, role: "member" })).rejects.toThrow(
      /already registered/,
    );

    const found = await repo.findUserByEmail(`  ${email.toUpperCase()} `);
    expect(found?.id).toBe(u.id);
    expect(found?.passwordHash).toBe("scrypt$hash");
    const got = await repo.getUser(u.id);
    expect(got?.tenantId).toBe(t);
    expect(got && "passwordHash" in got).toBe(false);

    await repo.setUserPassword(u.id, "scrypt$new");
    expect((await repo.findUserByEmail(email))?.passwordHash).toBe("scrypt$new");
    expect(await repo.findUserByEmail("nobody@example.com")).toBeNull();
  });

  it("sessions: touch extends, deleteUserSessions keeps the exception and other users", async () => {
    const t = await newTenant();
    const u1 = await repo.createUser({ tenantId: t, email: `a-${randomUUID()}@x.io`, passwordHash: null, role: "member" });
    const u2 = await repo.createUser({ tenantId: t, email: `b-${randomUUID()}@x.io`, passwordHash: null, role: "member" });
    const now = new Date();
    const mk = (id: string, userId: string) => ({
      id,
      userId,
      tenantId: t,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
      userAgent: "vitest",
      secretHash: "ab".repeat(32),
    });
    const [s1, s2, s3] = [`s1-${randomUUID()}`, `s2-${randomUUID()}`, `s3-${randomUUID()}`];
    await repo.createSession(mk(s1, u1.id));
    await repo.createSession(mk(s2, u1.id));
    await repo.createSession(mk(s3, u2.id));

    const got = await repo.getSession(s1);
    expect(got?.secretHash).toBe("ab".repeat(32));
    expect(got?.userAgent).toBe("vitest");
    expect(got?.tenantId).toBe(t);

    const later = new Date(now.getTime() + 7_200_000);
    await repo.touchSession(s1, later);
    expect(iso((await repo.getSession(s1))?.expiresAt)).toBe(later.toISOString());

    expect(await repo.deleteUserSessions(u1.id, s1)).toBe(1);
    expect(await repo.getSession(s1)).not.toBeNull();
    expect(await repo.getSession(s2)).toBeNull();
    expect(await repo.getSession(s3)).not.toBeNull();
    await repo.deleteSession(s1);
    expect(await repo.getSession(s1)).toBeNull();
  });

  it("API tokens are tenant-isolated; revoke only by the owning tenant, once", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const id = `tok${randomUUID().slice(0, 8)}`;
    await repo.createApiToken({
      id,
      tenantId: t1,
      userId: null,
      name: "laptop",
      scopes: ["cli", "agent"],
      createdAt: new Date(),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      secretHash: "cd".repeat(32),
    });
    expect((await repo.listApiTokens(t1)).map((x) => x.id)).toEqual([id]);
    expect(await repo.listApiTokens(t2)).toEqual([]);
    expect((await repo.listApiTokens(t1))[0]).not.toHaveProperty("secretHash");
    const got = await repo.getApiToken(id);
    expect(got?.scopes).toEqual(["cli", "agent"]);
    expect(got?.secretHash).toBe("cd".repeat(32));

    await repo.touchApiToken(id);
    expect((await repo.getApiToken(id))?.lastUsedAt).not.toBeNull();

    expect(await repo.revokeApiToken(t2, id)).toBe(false);
    expect((await repo.getApiToken(id))?.revokedAt).toBeNull();
    expect(await repo.revokeApiToken(t1, id)).toBe(true);
    expect(await repo.revokeApiToken(t1, id)).toBe(false);
    expect((await repo.getApiToken(id))?.revokedAt).not.toBeNull();
  });

  // ── profile / evidence / config ──
  it("profiles are per tenant and round-trip onboardedAt, resumeFile and prefs", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const onboardedAt = new Date("2026-01-02T03:04:05.000Z");
    const resumeFile = {
      key: `tenants/${t1}/resume/abcd1234-cv.pdf`,
      filename: "cv.pdf",
      mime: "application/pdf",
      sha256: "ef".repeat(32),
      bytes: 1234,
      uploadedAt: "2026-01-02T03:04:05.000Z",
    };
    const prefs = ProfilePrefs.parse({ homeCountry: "DE", markets: ["DE", "NL"], salaryFloor: 70000, currency: "EUR" });
    await repo.saveProfile(profileFor(t1, { masterResume: "resume text", onboardedAt, resumeFile, prefs, yoe: 4 }));
    await repo.saveProfile(profileFor(t2, { masterResume: "other" }));

    const p1 = await repo.getProfile(t1);
    expect(p1?.masterResume).toBe("resume text");
    expect(iso(p1?.onboardedAt)).toBe(onboardedAt.toISOString());
    expect(plain(p1?.resumeFile)).toEqual(resumeFile);
    expect(p1?.prefs.homeCountry).toBe("DE");
    expect(p1?.prefs.markets).toEqual(["DE", "NL"]);
    expect(p1?.prefs.salaryFloor).toBe(70000);
    expect(p1?.yoe).toBe(4);

    const p2 = await repo.getProfile(t2);
    expect(p2?.masterResume).toBe("other");
    expect(p2?.onboardedAt).toBeNull();
    expect(p2?.resumeFile).toBeNull();
    expect(await repo.getProfile(await newTenant())).toBeNull();

    // clearing onboardedAt / resumeFile persists
    await repo.saveProfile({ ...p1!, onboardedAt: null, resumeFile: null });
    const cleared = await repo.getProfile(t1);
    expect(cleared?.onboardedAt).toBeNull();
    expect(cleared?.resumeFile).toBeNull();
  });

  it("evidence is per tenant, upserts by id and round-trips origin", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const e1 = evidenceFor(t1, { origin: "resume" });
    const e2 = evidenceFor(t2, { origin: "sample" });
    await repo.saveEvidence(e1);
    await repo.saveEvidence(e2);
    await repo.saveEvidence({ ...e1, headline: "edited" });

    const l1 = await repo.listEvidence(t1);
    expect(l1).toHaveLength(1);
    expect(l1[0]?.headline).toBe("edited");
    expect(l1[0]?.origin).toBe("resume");
    expect((await repo.listEvidence(t2))[0]?.origin).toBe("sample");

    await repo.deleteEvidence(t2, e1.id); // wrong tenant → no-op
    expect(await repo.listEvidence(t1)).toHaveLength(1);
    await repo.deleteEvidence(t1, e1.id);
    expect(await repo.listEvidence(t1)).toHaveLength(0);
  });

  it("config round-trips the discovery preset, disabled preset feeds and the LLM key", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    await repo.saveConfig(configFor(t1, { discoveryPreset: "eu-uk", discoveryPresets: ["eu-uk", "global-remote"], presetFeedsDisabled: ["telegram", "hn"] }));
    await repo.saveConfig(configFor(t2));
    const c1 = await repo.getConfig(t1);
    expect(c1?.discoveryPreset).toBe("eu-uk");
    expect(c1?.discoveryPresets).toEqual(["eu-uk", "global-remote"]);
    expect(c1?.presetFeedsDisabled).toEqual(["telegram", "hn"]);
    expect(c1?.llmApiKey).toBe("sk-test-123");
    expect(c1?.sourcesEnabled).toEqual(["greenhouse", "lever"]);
    expect((await repo.getConfig(t2))?.discoveryPreset).toBe("india");
    expect(await repo.getConfig(await newTenant())).toBeNull();
  });

  // ── saved searches ──
  it("saved searches: tenant isolation, case-insensitive name clash, run recording", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const a = searchFor(t1, "Rust remote");
    await repo.saveSavedSearch(a);
    await expect(repo.saveSavedSearch(searchFor(t1, "rust REMOTE"))).rejects.toThrow(/already exists/);
    await repo.saveSavedSearch(searchFor(t2, "Rust remote")); // same name, other tenant: fine
    const b = searchFor(t1, "Berlin backend", { asSource: false });
    await repo.saveSavedSearch(b);

    expect((await repo.listSavedSearches(t1)).map((s) => s.name)).toEqual(["Berlin backend", "Rust remote"]);
    expect(await repo.getSavedSearch(t2, a.id)).toBeNull();
    const got = await repo.getSavedSearch(t1, a.id);
    expect(got?.query.keywords).toEqual(["rust"]);

    // renaming itself to a case variant of its own name is not a clash
    await repo.saveSavedSearch({ ...a, name: "RUST remote", enabled: false });
    expect((await repo.getSavedSearch(t1, a.id))?.name).toBe("RUST remote");
    // another tenant can't overwrite the row by id
    await expect(repo.saveSavedSearch({ ...a, tenantId: t2, name: "hijack" })).rejects.toThrow();
    expect((await repo.getSavedSearch(t1, a.id))?.name).toBe("RUST remote");

    await repo.recordSavedSearchRun(t2, b.id, { found: 99 }); // wrong tenant → no-op
    expect((await repo.getSavedSearch(t1, b.id))?.lastRunAt).toBeNull();
    await repo.recordSavedSearchRun(t1, b.id, { found: 3 });
    const ran = await repo.getSavedSearch(t1, b.id);
    expect(ran?.lastRunAt).not.toBeNull();
    expect(ran?.lastResult).toEqual({ found: 3 });

    const all = (await repo.listAllSourceSearches()).map((s) => s.id);
    expect(all).not.toContain(a.id); // disabled
    expect(all).not.toContain(b.id); // view only

    await repo.deleteSavedSearch(t2, b.id); // wrong tenant → no-op
    expect(await repo.getSavedSearch(t1, b.id)).not.toBeNull();
    await repo.deleteSavedSearch(t1, b.id);
    expect(await repo.getSavedSearch(t1, b.id)).toBeNull();
  });

  // ── discovery sources ──
  it("discovery sources dedupe by (tenant, configKey) and stay tenant-scoped", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const key = `k-${randomUUID()}`;
    const first = sourceFor(t1, key, { label: "first" });
    expect((await repo.saveDiscoverySource(first)).id).toBe(first.id);
    const again = await repo.saveDiscoverySource(sourceFor(t1, key, { label: "second" }));
    expect(again.id).toBe(first.id);
    expect(again.label).toBe("first");
    const other = sourceFor(t2, key);
    expect((await repo.saveDiscoverySource(other)).id).toBe(other.id); // other tenant: own row

    expect((await repo.listDiscoverySources(t1)).map((s) => s.id)).toEqual([first.id]);
    expect((await repo.listDiscoverySources(t1))[0]?.config).toEqual(first.config);
    await expect(repo.saveDiscoverySource({ ...first, tenantId: t2, configKey: `x-${randomUUID()}` })).rejects.toThrow();

    await repo.recordDiscoverySourceRun(first.id, { status: "error", count: 0, error: "boom" });
    const ran = (await repo.listDiscoverySources(t1))[0];
    expect(ran?.lastStatus).toBe("error");
    expect(ran?.lastCount).toBe(0);
    expect(ran?.lastError).toBe("boom");
    expect(ran?.lastRunAt).not.toBeNull();

    await repo.saveDiscoverySource({ ...first, enabled: false });
    const enabled = (await repo.listAllEnabledDiscoverySources()).map((s) => s.id);
    expect(enabled).toContain(other.id);
    expect(enabled).not.toContain(first.id);

    await repo.deleteDiscoverySource(t2, first.id); // wrong tenant → no-op
    expect(await repo.listDiscoverySources(t1)).toHaveLength(1);
    await repo.deleteDiscoverySource(t1, first.id);
    expect(await repo.listDiscoverySources(t1)).toHaveLength(0);
  });

  // ── follows ──
  it("company follows are an idempotent per-tenant overlay", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const co = await repo.upsertCompany({ name: "Follow Co", nameNorm: `follow-${randomUUID()}` });
    await repo.followCompany(t1, co.id);
    await repo.followCompany(t1, co.id);
    expect(await repo.listFollowedCompanyIds(t1)).toEqual([co.id]);
    expect(await repo.listFollowedCompanyIds(t2)).toEqual([]);
    await repo.unfollowCompany(t2, co.id);
    expect(await repo.listFollowedCompanyIds(t1)).toEqual([co.id]);
    await repo.unfollowCompany(t1, co.id);
    expect(await repo.listFollowedCompanyIds(t1)).toEqual([]);
  });

  // ── command plane ──
  it("claimJob honours the tenant filter; requeueStuckJobs re-queues only old running jobs", async () => {
    const [t1, t2] = [await newTenant(), await newTenant()];
    const j1 = await repo.enqueueJob({ tenantId: t1, type: "tier3_poll", runtime: "local" });
    const j2 = await repo.enqueueJob({ tenantId: t2, type: "tier3_poll", runtime: "local" });

    const c2 = await repo.claimJob("local", { tenantId: t2 });
    expect(c2?.id).toBe(j2.id);
    expect(c2?.status).toBe("running");
    expect(await repo.claimJob("local", { tenantId: t2 })).toBeNull();
    expect(await repo.claimJob("cloud", { tenantId: t1 })).toBeNull(); // wrong runtime

    const c1 = await repo.claimJob("local", { tenantId: t1 });
    expect(c1?.id).toBe(j1.id);

    expect(await repo.requeueStuckJobs("local", 60)).toBe(0); // just picked — not stuck
    await sleep(30);
    expect(await repo.requeueStuckJobs("local", 0.0002)).toBe(2); // 12 ms
    const again = await repo.claimJob("local", { tenantId: t1 });
    expect(again?.id).toBe(j1.id);
    await repo.completeJob(j1.id, "done", { result: { ok: true } });
    expect((await repo.listJobs(t1))[0]?.status).toBe("done");
    // drain t2's re-queued job so nothing is left running/queued
    expect((await repo.claimJob("local", { tenantId: t2 }))?.id).toBe(j2.id);
    await repo.completeJob(j2.id, "error", { error: "x" });
  });

  // ── postings (shared global) ──
  it("posting upsert is idempotent and markStale / invalidate behave", async () => {
    const co = await repo.upsertCompany({ name: "Acme", nameNorm: `acme-${randomUUID()}`, atsType: "greenhouse", atsSlug: "acme" });
    const np = postingFor(co.id);
    const p = await repo.upsertPosting(np);
    const p2 = await repo.upsertPosting(np);
    expect(p2.id).toBe(p.id);
    expect(p2.repostCount).toBe(0);
    expect((await repo.listPostingsByCompany(co.id)).map((x) => x.id)).toEqual([p.id]);

    const t = await newTenant();
    const m: Match = {
      id: randomUUID(),
      tenantId: t,
      postingId: p.id,
      score: 77,
      scoreBreakdown: { semantic: 0, stackAdjacency: 0, archetype: 0, seniority: 0, location: 0, freshness: 0, salary: 0, sourceTrust: 0.7 },
      rulePass: true,
      whyFit: null,
      gap: null,
      stackNote: null,
      levelNote: null,
      redFlags: [],
      generatedAt: new Date(),
    };
    await repo.saveMatches([m]);
    expect((await repo.listMatches(t)).map((x) => x.postingId)).toEqual([p.id]);
    expect(await repo.listMatches(await newTenant())).toEqual([]);

    await repo.invalidatePosting(p.id, "spam");
    expect((await repo.getPosting(p.id))?.status).toBe("invalidated");
    expect(await repo.listMatches(t)).toEqual([]);
    await repo.revalidatePosting(p.id);
    expect((await repo.getPosting(p.id))?.status).toBe("active");

    expect(await repo.markStale(co.id, [])).toBe(1);
    const stale = await repo.getPosting(p.id);
    expect(stale?.isActive).toBe(false);
    expect(stale?.status).toBe("stale");
    await repo.upsertPosting(np); // re-seen → active again
    expect((await repo.getPosting(p.id))?.status).toBe("active");
  });

  if (name === "pglite") {
    it("encrypts the LLM key at rest when JOBFLOW_SECRET_KEY is set (callers see plaintext)", async () => {
      const pg = repo as PgRepository;
      const t = await newTenant();
      const prev = process.env.JOBFLOW_SECRET_KEY;
      process.env.JOBFLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
      try {
        await repo.saveConfig(configFor(t, { llmApiKey: "sk-secret-value" }));
        const { rows } = await pg.client.query("select llm_api_key, llm_api_key_enc from tenant_config where tenant_id = $1", [t]);
        expect(rows[0]?.llm_api_key).toBe("");
        expect(String(rows[0]?.llm_api_key_enc)).toMatch(/^v1:/);
        expect(String(rows[0]?.llm_api_key_enc)).not.toContain("sk-secret-value");
        expect((await repo.getConfig(t))?.llmApiKey).toBe("sk-secret-value");
      } finally {
        if (prev === undefined) delete process.env.JOBFLOW_SECRET_KEY;
        else process.env.JOBFLOW_SECRET_KEY = prev;
      }
      // legacy plaintext rows still read back without a key
      const legacy = await newTenant();
      await repo.saveConfig(configFor(legacy, { llmApiKey: "sk-plain" }));
      expect((await repo.getConfig(legacy))?.llmApiKey).toBe("sk-plain");
    });
  }
});
