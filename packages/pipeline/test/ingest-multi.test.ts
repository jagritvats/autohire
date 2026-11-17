import { describe, expect, it } from "vitest";
import type { RawPosting } from "@jobflow/core";
import { markPartial, type FetchTarget, type SourceAdapter } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import { ingestCompany, marketsTagFor, prioritizeIndiaWorkable, prioritizeWorkable } from "../src/ingest.js";
import type { Embedder } from "../src/embedder.js";

const embedder: Embedder = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });

function raw(id: string, place: string): RawPosting {
  return {
    source: "workday",
    tier: "tier2",
    atsType: "workday",
    atsJobId: id,
    companyName: "acme",
    companySlug: "acme.wd5.myworkdayjobs.com/acme/External",
    title: `Engineer ${id}`,
    jdText: "Build services in Go.",
    jdHtml: null,
    locationRaw: place,
    applyUrl: null,
    salaryRaw: null,
    postedAt: null,
    fetchedAt: new Date(),
    raw: {},
  };
}

/** a country-filtered board whose answer per country is scripted. */
function board(script: Record<string, () => RawPosting[]>): SourceAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    source: "workday",
    tier: "tier2",
    calls,
    async fetch(t: FetchTarget) {
      calls.push(String(t.location));
      return script[String(t.location)]?.() ?? [];
    },
  };
}

async function setup() {
  const repo = new InMemoryRepository();
  const co = await repo.upsertCompany({ name: "Acme", nameNorm: "acme", atsType: "workday", atsSlug: "acme.wd5.myworkdayjobs.com/acme/External" });
  return { repo, co };
}

const active = async (repo: InMemoryRepository, companyId: string) =>
  (await repo.listPostingsByCompany(companyId)).filter((p) => p.status === "active").map((p) => p.atsJobId).sort();

describe("multi-country board polling (invariant #5: never stale on a partial fetch)", () => {
  it("fetches once per country, merges by id, and stales only on a complete, unchanged market set", async () => {
    const { repo, co } = await setup();
    let usJobs = [raw("U1", "Austin, TX"), raw("B1", "Austin, TX; Pune")];
    const adapter = board({ IN: () => [raw("I1", "Pune"), raw("B1", "Pune")], US: () => usJobs });

    const first = await ingestCompany(repo, co, { embedder, adapter, countries: ["IN", "US"] });
    expect(adapter.calls).toEqual(["IN", "US"]);
    expect(first.fetched).toBe(3); // B1 listed in both countries, merged
    expect(await active(repo, co.id)).toEqual(["B1", "I1", "U1"]);
    // the first multi-market poll records the market set (and can't diff yet)
    const tagged = (await repo.getCompany(co.id))!;
    expect(tagged.tags).toContain(marketsTagFor(["US", "IN"]));

    // same markets, both answered, U1 gone → staled
    usJobs = [raw("B1", "Austin, TX; Pune")];
    const second = await ingestCompany(repo, tagged, { embedder, adapter, countries: ["IN", "US"] });
    expect(second.staled).toBe(1);
    expect(await active(repo, co.id)).toEqual(["B1", "I1"]);
  });

  it("an EMPTY per-country fetch skips markStale (it can't be told from an error)", async () => {
    const { repo, co } = await setup();
    let usFails = false;
    const adapter = board({ IN: () => [raw("I1", "Pune")], US: () => (usFails ? [] : [raw("U1", "Austin, TX")]) });
    await ingestCompany(repo, co, { embedder, adapter, countries: ["IN", "US"] });
    const c1 = (await repo.getCompany(co.id))!;
    await ingestCompany(repo, c1, { embedder, adapter, countries: ["IN", "US"] }); // settle the market set
    expect(await active(repo, co.id)).toEqual(["I1", "U1"]);

    usFails = true; // the US fetch returns [] this time
    const r = await ingestCompany(repo, (await repo.getCompany(co.id))!, { embedder, adapter, countries: ["IN", "US"] });
    expect(r.staled).toBe(0);
    expect(await active(repo, co.id)).toEqual(["I1", "U1"]); // U1 survives; the TTL sweep decides later
  });

  it("a changed market set skips markStale once (roles from a dropped country aren't 'gone')", async () => {
    const { repo, co } = await setup();
    const adapter = board({ IN: () => [raw("I1", "Pune")], US: () => [raw("U1", "Austin, TX")], DE: () => [raw("D1", "Berlin")] });
    await ingestCompany(repo, co, { embedder, adapter, countries: ["IN", "US"] });
    const r = await ingestCompany(repo, (await repo.getCompany(co.id))!, { embedder, adapter, countries: ["IN", "DE"] });
    expect(r.staled).toBe(0);
    expect(await active(repo, co.id)).toEqual(["D1", "I1", "U1"]);
    expect((await repo.getCompany(co.id))!.tags).toContain(marketsTagFor(["IN", "DE"]));
    // back to one market: still a change (tag removed), no stale this run
    const single = await ingestCompany(repo, (await repo.getCompany(co.id))!, { embedder, adapter, country: "IN" });
    expect(single.staled).toBe(0);
    expect((await repo.getCompany(co.id))!.tags.some((t) => t.startsWith("poll-markets:"))).toBe(false);
  });

  it("the single-market path behaves as before: full fetch diffed, empty fetch never stales", async () => {
    const { repo, co } = await setup();
    let jobs = [raw("I1", "Pune"), raw("I2", "Bengaluru")];
    const adapter = board({ IN: () => jobs });
    await ingestCompany(repo, co, { embedder, adapter, country: "IN" });
    jobs = [raw("I1", "Pune")];
    const r = await ingestCompany(repo, co, { embedder, adapter, country: "IN" });
    expect(r.staled).toBe(1);
    expect((await repo.getCompany(co.id))!.tags).toEqual([]); // no market bookkeeping on the single path
    jobs = [];
    expect((await ingestCompany(repo, co, { embedder, adapter, country: "IN" })).staled).toBe(0);
    expect(await active(repo, co.id)).toEqual(["I1"]);
  });

  it("a partial fetch (e.g. Workday's unfiltered fallback) is never diffed", async () => {
    const { repo, co } = await setup();
    let partial = false;
    const adapter = board({ IN: () => (partial ? markPartial([raw("I1", "Pune")]) : [raw("I1", "Pune"), raw("I2", "Pune")]) });
    await ingestCompany(repo, co, { embedder, adapter, country: "IN" });
    partial = true;
    expect((await ingestCompany(repo, co, { embedder, adapter, country: "IN" })).staled).toBe(0);
    expect(await active(repo, co.id)).toEqual(["I1", "I2"]);
  });

  it("a non-country-filtered board is fetched once even for several markets", async () => {
    const repo = new InMemoryRepository();
    const co = await repo.upsertCompany({ name: "Gh", nameNorm: "gh", atsType: "greenhouse", atsSlug: "gh" });
    const calls: string[] = [];
    const gh: SourceAdapter = {
      source: "greenhouse",
      tier: "tier1",
      async fetch(t) {
        calls.push(String(t.location));
        return [{ ...raw("G1", "Remote"), source: "greenhouse", atsType: "greenhouse", tier: "tier1" }];
      },
    };
    await ingestCompany(repo, co, { embedder, adapter: gh, countries: ["IN", "US"] });
    expect(calls).toEqual(["IN"]);
  });

  it("prioritizeWorkable is region-neutral; the India wrapper is unchanged", () => {
    const raws = [raw("1", "Austin, TX"), raw("2", "Pune, India"), raw("3", "Remote - Worldwide")];
    expect(prioritizeIndiaWorkable(raws).map((r) => r.atsJobId)).toEqual(["2", "3", "1"]);
    expect(prioritizeWorkable(raws, ["US"]).map((r) => r.atsJobId)).toEqual(["1", "3", "2"]);
  });
});
