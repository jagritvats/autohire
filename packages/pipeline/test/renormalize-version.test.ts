import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { NORMALIZE_VERSION, NORMALIZE_VERSION_KEY, normalizePosting, RawPosting } from "@jobflow/core";
import { toNewPosting } from "../src/ingest.js";
import { localEmbedder } from "../src/embedder.js";
import { pollAll } from "../src/poll.js";
import { renormalizeIfStale } from "../src/renormalize.js";

/**
 * Automatic re-normalization: a store records the NORMALIZE_VERSION its rows were derived with,
 * and the next sync (pollAll — CLI, web, worker, MCP) re-derives stored postings once when the
 * code is newer. Fictional data; no network (every source is switched off).
 */

const quiet = { embedder: localEmbedder, feeds: [], customSources: false, searches: false, telegramChannels: [], discoverNewSeeds: false } as const;

/** a store holding one posting as an older parser stored it: "London, Berlin" read as the UK only */
async function storeWithOldRow(): Promise<{ repo: InMemoryRepository; id: string }> {
  const repo = new InMemoryRepository();
  const n = normalizePosting(
    RawPosting.parse({ source: "hn_whoishiring", tier: "tier1", atsJobId: "1", companyName: "Examplecorp", title: "Backend Engineer", jdText: "Go services.", locationRaw: "London, Berlin" }),
  );
  const np = await toNewPosting(n, "c1", n.companyName, localEmbedder);
  const p = await repo.upsertPosting({ ...np, location: { ...np.location, country: "Europe", countries: ["GB"] } });
  return { repo, id: p.id };
}

describe("renormalizeIfStale", () => {
  it("re-derives once when the store never recorded a version, then records it", async () => {
    const { repo, id } = await storeWithOldRow();
    const r = await renormalizeIfStale(repo);
    expect(r).toMatchObject({ fromVersion: null, toVersion: NORMALIZE_VERSION, scanned: 1, changed: 1, multiCountry: 1 });
    expect((await repo.getPosting(id))?.location).toMatchObject({ country: "United Kingdom", countries: ["GB", "DE"] });
    expect(await repo.getStoreMeta(NORMALIZE_VERSION_KEY)).toBe(String(NORMALIZE_VERSION));
    // current: nothing to do (one meta read)
    expect(await renormalizeIfStale(repo)).toBeNull();
    // forced (`jobflow renormalize`): runs, changes nothing
    expect(await renormalizeIfStale(repo, { force: true })).toMatchObject({ scanned: 1, changed: 0 });
  });

  it("runs when the recorded version is older; leaves a store recorded by newer code alone", async () => {
    const older = await storeWithOldRow();
    await older.repo.setStoreMeta(NORMALIZE_VERSION_KEY, String(NORMALIZE_VERSION - 1));
    expect((await renormalizeIfStale(older.repo))?.changed).toBe(1);

    const newer = await storeWithOldRow();
    await newer.repo.setStoreMeta(NORMALIZE_VERSION_KEY, String(NORMALIZE_VERSION + 1));
    expect(await renormalizeIfStale(newer.repo)).toBeNull();
    expect((await newer.repo.getPosting(newer.id))?.location.countries).toEqual(["GB"]);
    expect(await newer.repo.getStoreMeta(NORMALIZE_VERSION_KEY)).toBe(String(NORMALIZE_VERSION + 1));
  });
});

describe("pollAll re-normalizes a stale store before polling", () => {
  it("the first sync after an upgrade re-derives stored rows; the next one doesn't", async () => {
    const { repo, id } = await storeWithOldRow();
    const lines: string[] = [];
    const first = await pollAll(repo, { ...quiet, log: (m) => lines.push(m) });
    expect(first.renormalized).toMatchObject({ changed: 1, toVersion: NORMALIZE_VERSION });
    expect(lines.some((l) => l.includes("re-normalized stored postings"))).toBe(true);
    expect((await repo.getPosting(id))?.location.countries).toEqual(["GB", "DE"]);
    const second = await pollAll(repo, quiet);
    expect(second.renormalized).toBeUndefined();
  });

  it("a fresh store just records the version", async () => {
    const repo = new InMemoryRepository();
    const s = await pollAll(repo, quiet);
    expect(s.renormalized).toMatchObject({ scanned: 0, changed: 0 });
    expect(await repo.getStoreMeta(NORMALIZE_VERSION_KEY)).toBe(String(NORMALIZE_VERSION));
  });
});
