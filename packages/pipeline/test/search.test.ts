import { describe, expect, it } from "vitest";
import { SearchQuery, scorePosting, type RawPosting, type SavedSearch } from "@jobflow/core";
import type { FetchTarget, SourceAdapter } from "@jobflow/adapters";
import { InMemoryRepository, type Repository } from "@jobflow/db";
import { randomUUID } from "node:crypto";
import { adhocSearch, makeSearchQuery, runSavedSearch } from "../src/search.js";
import { sampleProfile } from "../src/sample.js";
import { ingestRaws } from "../src/ingest.js";
import type { Embedder } from "../src/embedder.js";

const embedder: Embedder = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });
const NOW = Date.parse("2026-11-17T00:00:00Z");

function raw(id: string, over: Partial<RawPosting> = {}): RawPosting {
  return {
    source: "remotive",
    tier: "tier1",
    atsType: "unknown",
    atsJobId: id,
    companyName: `Co ${id}`,
    companySlug: null,
    title: "Backend Engineer",
    jdText: "Java, Kafka and Postgres services.",
    jdHtml: null,
    locationRaw: "Remote - Worldwide",
    applyUrl: `https://example.com/${id}`,
    salaryRaw: null,
    postedAt: new Date(NOW - 86_400_000).toISOString(),
    fetchedAt: new Date(NOW),
    raw: {},
    ...over,
  };
}

function fakeAdapter(source: "remotive" | "himalayas", raws: RawPosting[], tier: "tier1" | "tier3" = "tier1"): SourceAdapter & { targets: FetchTarget[] } {
  const targets: FetchTarget[] = [];
  return {
    source,
    tier,
    targets,
    toTargets: (q) => q.keywords.map((k) => ({ query: k })),
    async fetch(t) {
      targets.push(t);
      return raws.map((r) => ({ ...r, source }));
    },
  };
}

/** a repo whose every WRITE throws — proves a read-only path never writes. */
function readOnly(repo: Repository): Repository & { writes: string[] } {
  const writes: string[] = [];
  const reads = /^(get|list|find|count|applied)/;
  return new Proxy(repo, {
    get(target, prop, recv) {
      if (prop === "writes") return writes;
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && !reads.test(prop)) {
          writes.push(prop);
          throw new Error(`write attempted: ${prop}`);
        }
        return v.apply(target, args);
      };
    },
  }) as Repository & { writes: string[] };
}

describe("adhocSearch", () => {
  const profile = sampleProfile();

  it("fetches, scores with the real scorer, applies the view — and writes NOTHING", async () => {
    const base = new InMemoryRepository();
    // one result is already in the corpus (inFeed)
    await ingestRaws(base, "remotive", [raw("r1")], embedder);
    const before = (await base.listActivePostings()).length;
    const repo = readOnly(base);
    const adapter = fakeAdapter("remotive", [
      raw("r1"),
      raw("r2", { title: "Senior Backend Engineer" }),
      raw("r3", { title: "Junior Data Analyst", jdText: "Excel" }),
      raw("r4", { companyName: "Evil Corp" }),
      raw("r5", { locationRaw: "Austin, TX", jdText: "Java services. We do not sponsor visas. No sponsorship." }),
    ]);
    const res = await adhocSearch(
      { keywords: ["backend"], excludeCompanies: ["Evil Corp"] },
      { ...profile, prefs: { ...profile.prefs, relocate: false } },
      { embedder, repo, adapters: [adapter], now: NOW },
    );
    expect(repo.writes).toEqual([]);
    expect((await base.listActivePostings()).length).toBe(before);

    expect(res.fetched).toBe(5);
    expect(res.bySource).toEqual({ remotive: 5 });
    expect(res.hidden.company).toBe(1);
    expect(res.hiddenTotal).toBe(1);
    expect(res.excluded).toBe(1); // onsite US, no sponsorship, relocation off — the scorer's own rule
    const ids = res.results.map((r) => r.posting.atsJobId);
    expect(ids).toEqual(expect.arrayContaining(["remotive:r1", "remotive:r2", "remotive:r3"]));
    expect(res.results.find((r) => r.posting.atsJobId === "remotive:r1")!.inFeed).toBe(true);
    expect(res.results.find((r) => r.posting.atsJobId === "remotive:r2")!.inFeed).toBe(false);
    // ranked by score, with the scorer's exact score (no view-side rescoring)
    for (let i = 1; i < res.results.length; i++) expect(res.results[i - 1]!.match.score).toBeGreaterThanOrEqual(res.results[i]!.match.score);
    for (const r of res.results) expect(r.match.score).toBe(scorePosting(r.posting, { ...profile, prefs: { ...profile.prefs, relocate: false } }).score);
    expect(adapter.targets).toEqual([{ query: "backend" }]);
  });

  it("ingest: true upserts idempotently (once per key)", async () => {
    const repo = new InMemoryRepository();
    const adapter = fakeAdapter("remotive", [raw("a"), raw("b")]);
    const r1 = await adhocSearch({ keywords: ["backend"] }, profile, { embedder, repo, adapters: [adapter], ingest: true, now: NOW });
    expect(r1.ingested).toBe(2);
    await adhocSearch({ keywords: ["backend"] }, profile, { embedder, repo, adapters: [adapter], ingest: true, now: NOW });
    expect((await repo.listActivePostings()).length).toBe(2);
  });

  it("only cloud adapters are ever used", async () => {
    const rogue = fakeAdapter("himalayas", [raw("x")], "tier3");
    const res = await adhocSearch({ keywords: ["backend"] }, profile, { embedder, adapters: [rogue], now: NOW });
    expect(rogue.targets).toEqual([]);
    expect(res.fetched).toBe(0);
    // a Tier-3 source named in the query resolves to nothing
    const named = await adhocSearch({ keywords: ["backend"], sources: ["naukri", "linkedin"] }, profile, { embedder, now: NOW });
    expect(named.sources).toEqual([]);
  });
});

describe("runSavedSearch", () => {
  it("ingests through the search's sources and records the run", async () => {
    const repo = new InMemoryRepository();
    const tenantId = "00000000-0000-0000-0000-000000000001";
    const search: SavedSearch = {
      id: randomUUID(),
      tenantId,
      name: "remote java",
      query: SearchQuery.parse({ keywords: ["java"], sources: ["remotive"] }),
      asSource: true,
      asView: true,
      cadence: "daily",
      enabled: true,
      lastRunAt: null,
      lastResult: null,
      createdAt: new Date(),
    };
    await repo.saveSavedSearch(search);
    const { ADAPTERS } = await import("@jobflow/adapters");
    const original = ADAPTERS.remotive!.fetch;
    ADAPTERS.remotive!.fetch = async () => [raw("s1"), raw("s2")];
    try {
      const r = await runSavedSearch(repo, search, { embedder, markets: ["IN"], yoe: 3 });
      expect(r.fetched).toBe(2);
      expect(r.bySource).toEqual({ remotive: 2 });
      // idempotent: re-running upserts the same rows
      await runSavedSearch(repo, search, { embedder, markets: ["IN"], yoe: 3 });
      expect((await repo.listActivePostings()).length).toBe(2);
      const saved = await repo.getSavedSearch(tenantId, search.id);
      expect(saved!.lastRunAt).not.toBeNull();
      expect(saved!.lastResult).toMatchObject({ fetched: 2 });
    } finally {
      ADAPTERS.remotive!.fetch = original;
    }
  });
});

describe("makeSearchQuery (CLI-style input)", () => {
  it('"staff backend" --remote --loc Berlin,DE --seniority senior', () => {
    const q = makeSearchQuery(`"staff backend" --remote --loc Berlin,DE --seniority senior`);
    expect(q.keywords).toEqual(["staff backend"]);
    expect(q.remote).toBe("only");
    expect(q.locations).toEqual([{ city: "Berlin", country: "DE" }]);
    expect(q.seniority).toEqual(["senior"]);
  });

  it("bare words form one phrase; flags cover the facets", () => {
    const q = makeSearchQuery(
      `platform engineer --loc "Bengaluru" --loc US --min-salary 40L INR --posted 2w --source himalayas,naukri --must go,kafka --nice rust --exclude-company "Evil Corp" --exclude crypto --onsite --seniority mid,sde3`,
    );
    expect(q.keywords).toEqual(["platform engineer"]);
    expect(q.locations).toEqual([{ city: "Bengaluru", country: "IN" }, { city: null, country: "US" }]);
    expect(q.minSalary).toEqual({ amount: 4_000_000, currency: "INR" });
    expect(q.postedWithinDays).toBe(14);
    expect(q.sources).toEqual(["himalayas", "naukri"]); // a SourceKind — the plan/adapters drop non-cloud ones
    expect(q.mustSkills).toEqual(["go", "kafka"]);
    expect(q.niceSkills).toEqual(["rust"]);
    expect(q.excludeCompanies).toEqual(["Evil Corp"]);
    expect(q.excludeKeywords).toEqual(["crypto"]);
    expect(q.remote).toBe("exclude");
    expect(q.seniority).toEqual(["mid", "senior"]);
  });

  it("flags object merges on top; --loc remote means remote-only; $ amounts", () => {
    const q = makeSearchQuery("sre", { loc: "Remote", minSalary: "$150k", posted: 7 });
    expect(q.remote).toBe("only");
    expect(q.locations).toEqual([]);
    expect(q.minSalary).toEqual({ amount: 150_000, currency: "USD" });
    expect(q.postedWithinDays).toBe(7);
    expect(makeSearchQuery("").keywords).toEqual([]);
    expect(makeSearchQuery("x --min-salary 40LPA --currency INR").minSalary).toEqual({ amount: 4_000_000, currency: "INR" });
    expect(makeSearchQuery("x --min-salary €90k").minSalary).toEqual({ amount: 90_000, currency: "EUR" });
  });
});
