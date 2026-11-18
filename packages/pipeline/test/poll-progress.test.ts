import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawPosting } from "@jobflow/core";
import { ADAPTERS, type FetchTarget } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import { pollAll } from "../src/poll.js";
import type { PollEvent } from "../src/progress.js";
import type { Embedder } from "../src/embedder.js";

/**
 * pollAll's structured progress and its cancel path: events in phase order, per-board
 * counts (new / updated / gone), and a cancelled run that stops starting boards, stores what
 * it fetched, and retires NOTHING (no markStale, no sweep — invariant #5).
 */

const embedder: Embedder = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });
const quiet = { embedder, feeds: [], customSources: false, searches: false, telegramChannels: [], discoverNewSeeds: false } as const;

function raw(slug: string, id: string): RawPosting {
  return {
    source: "greenhouse",
    tier: "tier1",
    atsType: "greenhouse",
    atsJobId: id,
    companyName: slug,
    companySlug: slug,
    title: `Engineer ${id}`,
    jdText: "Build services in Go.",
    jdHtml: null,
    locationRaw: "Remote",
    applyUrl: null,
    salaryRaw: null,
    postedAt: null,
    fetchedAt: new Date(),
    raw: {},
  };
}

describe("pollAll progress + cancel", () => {
  const original = ADAPTERS.greenhouse!.fetch;
  /** what each board lists now */
  let listing: Record<string, string[]> = {};
  let onFetch: (slug: string) => void = () => {};
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    ADAPTERS.greenhouse!.fetch = async (t: FetchTarget) => {
      const slug = String(t.slug);
      onFetch(slug);
      await new Promise((r) => setTimeout(r, 15));
      return (listing[slug] ?? []).map((id) => raw(slug, `${slug}-${id}`));
    };
  });
  afterEach(() => {
    ADAPTERS.greenhouse!.fetch = original;
    onFetch = () => {};
    listing = {};
    vi.unstubAllGlobals();
  });

  async function registry(n: number) {
    const repo = new InMemoryRepository();
    for (let i = 0; i < n; i++) await repo.upsertCompany({ name: `Example ${i}`, nameNorm: `example ${i}`, atsType: "greenhouse", atsSlug: `ex${i}` });
    return repo;
  }

  it("reports phases in order, the plan, and per-board new / updated / gone", async () => {
    const repo = await registry(2);
    listing = { ex0: ["a", "b"], ex1: ["c"] };
    await pollAll(repo, quiet); // first sync: everything is new
    listing = { ex0: ["a", "d"], ex1: ["c"] }; // b closed, d opened
    const events: PollEvent[] = [];
    await pollAll(repo, { ...quiet, allCompanies: true, onProgress: (e) => events.push(e) });

    const phases = events.filter((e) => e.type === "phase").map((e) => `${(e as { phase: string }).phase}:${(e as { state: string }).state}`);
    expect(phases).toEqual([
      "discover:skipped",
      "boards:start",
      "boards:done",
      "feeds:start",
      "feeds:done",
      "resolve:start",
      "resolve:done",
      "expire:start",
      "expire:done",
      "process:start",
      "process:done",
    ]);
    expect(events.find((e) => e.type === "plan")).toMatchObject({ boards: 2, deferred: 0 });
    const done = events.filter((e): e is Extract<PollEvent, { type: "board"; state: "done" }> => e.type === "board" && e.state === "done");
    const ex0 = done.find((d) => d.name === "Example 0")!;
    expect(ex0).toMatchObject({ fetched: 2, created: 1, updated: 1, staled: 1 });
    expect(ex0.ms).toBeGreaterThanOrEqual(0);
    expect(events.filter((e) => e.type === "board" && e.state === "start")).toHaveLength(2);
  });

  it("a cancelled run stops starting boards, keeps what it fetched, and retires nothing", async () => {
    const repo = await registry(6);
    // every board already holds a posting its board no longer lists: a normal poll would stale it
    listing = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`ex${i}`, ["old", "keep"]]));
    await pollAll(repo, quiet);
    listing = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`ex${i}`, ["keep", "fresh"]]));

    const controller = new AbortController();
    // cancel while the first board is in flight
    onFetch = () => controller.abort();
    const events: PollEvent[] = [];
    const stats = await pollAll(repo, { ...quiet, allCompanies: true, concurrency: 1, signal: controller.signal, onProgress: (e) => events.push(e) });

    expect(stats.cancelled).toBe(true);
    expect(stats.companiesPolled).toBe(1); // the in-flight one finished; no other started
    expect(stats.staled).toBe(0); // its fetch completed, but a cancelled run never diffs
    expect(stats.boardsDeferred).toBe(5);
    const all = (await repo.listActivePostings()).map((p) => p.atsJobId);
    expect(all.filter((id) => id.endsWith("-old"))).toHaveLength(6); // nothing retired anywhere
    expect(all.filter((id) => id.endsWith("-fresh"))).toHaveLength(1); // what it fetched is stored
    const phases = events.filter((e) => e.type === "phase").map((e) => `${(e as { phase: string }).phase}:${(e as { state: string }).state}`);
    expect(phases).toEqual(["discover:skipped", "boards:start", "boards:done", "feeds:skipped", "resolve:skipped", "expire:skipped", "process:skipped"]);
    expect(events.filter((e) => e.type === "board" && e.state === "deferred")).toHaveLength(5);
  });
});
