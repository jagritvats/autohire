import { afterEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { FX_AS_OF, SALARY_PARSE_VERSION, SALARY_PARSE_VERSION_KEY, activeFx, convertCurrency, normalizePosting, resetFxRates, RawPosting } from "@jobflow/core";
import { toNewPosting } from "../src/ingest.js";
import { localEmbedder } from "../src/embedder.js";
import { FX_META_KEY, loadFxRates, parseFrankfurter, refreshFxRates } from "../src/fx.js";
import { reparseSalariesIfStale } from "../src/salary.js";

// FX refresh (optional, cached in the store, never required) and the once-per-version salary
// re-parse a sync runs. Fictional data; the FX "API" is a stub — no network.

const payload = (date: string, inr = 100) => ({ amount: 1, base: "USD", date, rates: { INR: inr, EUR: 0.9, GBP: 0.8, CAD: 1.4, AUD: 1.5 } });

describe("refreshFxRates", () => {
  afterEach(() => resetFxRates());

  it("fetches, caches with its date, and converts at the new rate", async () => {
    const repo = new InMemoryRepository();
    const r = await refreshFxRates(repo, { fetchJson: async () => payload("2099-03-04"), now: new Date("2099-03-04T10:00:00Z") });
    expect(r).toMatchObject({ status: "fetched", table: { asOf: "2099-03-04" } });
    expect(convertCurrency(100, "INR", "USD")).toBeCloseTo(1, 6);
    expect(JSON.parse((await repo.getStoreMeta(FX_META_KEY))!)).toMatchObject({ asOf: "2099-03-04", fetchedAt: "2099-03-04T10:00:00.000Z" });

    // another process on the same store picks it up without the network
    resetFxRates();
    expect((await loadFxRates(repo)).asOf).toBe("2099-03-04");

    // fresh enough → not re-fetched
    let calls = 0;
    const again = await refreshFxRates(repo, { fetchJson: async () => (calls++, payload("2099-03-05")), now: new Date("2099-03-04T20:00:00Z") });
    expect(again.status).toBe("cached");
    expect(calls).toBe(0);
  });

  it("unreachable or garbage: keeps the shipped table, never throws", async () => {
    const repo = new InMemoryRepository();
    expect(await refreshFxRates(repo, { fetchJson: async () => { throw new Error("offline"); } })).toMatchObject({ status: "static", table: { asOf: FX_AS_OF } });
    expect(await refreshFxRates(repo, { fetchJson: async () => ({ hello: "world" }) })).toMatchObject({ status: "static" });
    expect(parseFrankfurter({ base: "EUR", date: "2099-01-01", rates: {} })).toBeNull();
    expect(activeFx().asOf).toBe(FX_AS_OF);
  });
});

describe("reparseSalariesIfStale", () => {
  it("re-parses stored bands once per SALARY_PARSE_VERSION and records the period", async () => {
    const repo = new InMemoryRepository();
    const n = normalizePosting(
      RawPosting.parse({ source: "lever", tier: "tier1", atsJobId: "1", companyName: "Examplecorp", title: "Backend Engineer", jdText: "Go.", salaryRaw: "€5,500 – €6,500 per month", locationRaw: "Berlin, Germany" }),
    );
    const np = await toNewPosting(n, "c1", n.companyName, localEmbedder);
    // as an older parser stored it: annualised, no period
    const p = await repo.upsertPosting({ ...np, salary: { min: 66_000, max: 78_000, currency: "EUR", source: "jd_direct", confidence: "high" } });
    const r = await reparseSalariesIfStale(repo);
    expect(r).toMatchObject({ fromVersion: null, toVersion: SALARY_PARSE_VERSION, changed: 1 });
    expect((await repo.getPosting(p.id))?.salary).toMatchObject({ min: 66_000, max: 78_000, currency: "EUR", period: "month" });
    expect(await repo.getStoreMeta(SALARY_PARSE_VERSION_KEY)).toBe(String(SALARY_PARSE_VERSION));
    expect(await reparseSalariesIfStale(repo)).toBeNull();
    expect(await reparseSalariesIfStale(repo, { force: true })).toMatchObject({ changed: 0 });
  });
});
