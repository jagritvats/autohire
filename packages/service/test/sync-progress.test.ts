import { afterEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import type { PollEvent } from "@jobflow/pipeline";
import {
  applySyncEvent,
  cancelCorpusSync,
  corpusSyncing,
  estimateEtaMs,
  loadSampleProfile,
  newSyncProgress,
  nextSyncAt,
  plainError,
  setSyncSchedule,
  startCorpusSync,
  subscribeSync,
  syncFraction,
  syncStatus,
  syncViewFor,
} from "../src/index.js";
import type { SyncProgress } from "@jobflow/core";

const T0 = 1_700_000_000_000;
const fresh = () => newSyncProgress({ runId: "r1", trigger: "manual", origin: "web", now: T0 });
const fold = (s: SyncProgress, events: Array<[number, PollEvent]>) => {
  for (const [dt, e] of events) applySyncEvent(s, e, T0 + dt);
  return s;
};

describe("sync progress model", () => {
  it("walks the phases in order: one active at a time, done or skipped after", () => {
    const s = fresh();
    expect(s.phases.map((p) => p.status)).toEqual(Array(8).fill("pending"));
    fold(s, [
      [0, { type: "phase", phase: "discover", state: "skipped" }],
      [10, { type: "phase", phase: "boards", state: "start" }],
    ]);
    expect(s.phase).toBe("boards");
    expect(s.phases.find((p) => p.id === "discover")?.status).toBe("skipped");
    expect(s.phases.find((p) => p.id === "boards")).toMatchObject({ status: "active", startedAt: T0 + 10 });
    fold(s, [[500, { type: "phase", phase: "boards", state: "done" }]]);
    expect(s.phase).toBeNull();
    expect(s.phases.find((p) => p.id === "boards")).toMatchObject({ status: "done", finishedAt: T0 + 500 });
  });

  it("counts boards, in-flight names, postings and plain-language errors", () => {
    const s = fold(fresh(), [
      [0, { type: "phase", phase: "boards", state: "start" }],
      [0, { type: "plan", boards: 4, deferred: 2, notDue: 10, budgetMs: 60_000, concurrency: 2 }],
      [1, { type: "board", state: "start", id: "a", name: "Acme" }],
      [2, { type: "board", state: "start", id: "b", name: "Bolt" }],
    ]);
    expect(s.boards.inFlight).toEqual(["Acme", "Bolt"]);
    fold(s, [
      [1001, { type: "board", state: "done", id: "a", name: "Acme", fetched: 10, created: 3, updated: 7, staled: 1, ms: 1000 }],
      [3002, { type: "board", state: "done", id: "b", name: "Bolt", fetched: 0, created: 0, updated: 0, staled: 0, ms: 3000, error: "fetch failed: ETIMEDOUT" }],
    ]);
    expect(s.boards).toMatchObject({ total: 4, done: 1, failed: 1, deferred: 2, notDue: 10, inFlight: [] });
    expect(s.postings).toMatchObject({ fetched: 10, new: 3, updated: 7, gone: 1 });
    expect(s.timing.avgBoardMs).toBe(2000);
    expect(s.errors).toEqual([{ source: "Bolt", message: "didn't answer in time (timed out)" }]);
  });

  it("estimates time left from board timings, never past the time budget", () => {
    const s = fold(fresh(), [
      [0, { type: "phase", phase: "discover", state: "skipped" }],
      [0, { type: "phase", phase: "boards", state: "start" }],
      [0, { type: "plan", boards: 102, deferred: 0, notDue: 0, budgetMs: 600_000, concurrency: 4 }],
    ]);
    expect(estimateEtaMs(s, T0)).toBeNull(); // no board finished yet: nothing to go on
    fold(s, [
      [2000, { type: "board", state: "done", id: "a", name: "A", fetched: 1, created: 0, updated: 1, staled: 0, ms: 2000 }],
      [2000, { type: "board", state: "done", id: "b", name: "B", fetched: 1, created: 0, updated: 1, staled: 0, ms: 2000 }],
    ]);
    // 100 boards × 2 s ÷ 4 at once = 50 s, + feeds (4 guessed × 3 s) + the tail (6 s)
    expect(estimateEtaMs(s, T0 + 2000)).toBe(50_000 + 12_000 + 6_000);
    // a tight budget caps the board part: 10 s left + one board in flight
    s.timing.budgetMs = 12_000;
    expect(estimateEtaMs(s, T0 + 2000)).toBe(10_000 + 2_000 + 12_000 + 6_000);
    // nothing once finished, or once cancel is asked
    s.cancelRequested = true;
    expect(estimateEtaMs(s, T0 + 2000)).toBeNull();
  });

  it("fraction grows with the boards and never reads 100% while running", () => {
    const s = fold(fresh(), [
      [0, { type: "phase", phase: "discover", state: "done" }],
      [0, { type: "phase", phase: "boards", state: "start" }],
      [0, { type: "plan", boards: 2, deferred: 0, notDue: 0, budgetMs: null, concurrency: 1 }],
    ]);
    const before = syncFraction(s);
    fold(s, [[1, { type: "board", state: "done", id: "a", name: "A", fetched: 1, created: 1, updated: 0, staled: 0, ms: 1 }]]);
    expect(syncFraction(s)).toBeGreaterThan(before);
    for (const p of s.phases) p.status = "done";
    expect(syncFraction(s)).toBeLessThan(1);
  });

  it("shows a tenant's own sources and their errors only to that tenant", () => {
    const s = fold(fresh(), [
      [0, { type: "source", state: "start", key: "custom:k1", label: "jobs.example.org", kind: "custom", tenantIds: ["t-a"] }],
      [5, { type: "source", state: "done", key: "custom:k1", fetched: 0, created: 0, ms: 5, error: "HTTP 404" }],
      [6, { type: "source", state: "start", key: "feed:remotive", label: "remotive", kind: "feed" }],
      [9, { type: "source", state: "done", key: "feed:remotive", fetched: 4, created: 2, ms: 3 }],
    ]);
    const a = syncViewFor(s, "t-a", T0 + 10);
    const b = syncViewFor(s, "t-b", T0 + 10);
    expect(Object.keys(a.sources).sort()).toEqual(["custom:k1", "feed:remotive"]);
    expect(a.errors[0]?.source).toBe("jobs.example.org");
    expect(a.errors[0]).not.toHaveProperty("tenantIds");
    expect(Object.keys(b.sources)).toEqual(["feed:remotive"]);
    expect(b.errors).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("example.org");
  });

  it("says fetch errors in plain words", () => {
    expect(plainError("HTTP 429 Too Many Requests")).toMatch(/slow down/);
    expect(plainError("getaddrinfo ENOTFOUND boards.example")).toMatch(/couldn't be reached/);
    expect(plainError("Request failed with status 403")).toMatch(/refused/);
    expect(plainError("something odd")).toBe("something odd");
  });

  it("the next scheduled sync is the first look after the period, or the next look while catching up", () => {
    const every = 6 * 3_600_000;
    const look = T0 + 5 * 60_000;
    expect(nextSyncAt(null, T0, T0)).toBeNull();
    expect(nextSyncAt({ everyMs: every, nextCheckAt: look, catchUp: true }, T0, T0)).toBe(look);
    const n = nextSyncAt({ everyMs: every, nextCheckAt: look, catchUp: false }, T0, T0)!;
    expect(n).toBeGreaterThanOrEqual(T0 + every);
    expect(n - (T0 + every)).toBeLessThan(15 * 60_000);
  });
});

describe("sync runs (start, watch, cancel, history)", () => {
  afterEach(() => setSyncSchedule(null));

  it("a run reports live, ranks after, and is kept (in memory and in the store)", async () => {
    const repo = new InMemoryRepository();
    const seen: string[] = [];
    const off = subscribeSync((s) => seen.push(`${s.status}:${s.phase ?? "-"}`));
    let ranked = false;
    await startCorpusSync(
      repo,
      async () => void (ranked = true),
      async (_r, { onProgress }) => {
        onProgress({ type: "phase", phase: "boards", state: "start" });
        onProgress({ type: "plan", boards: 1, deferred: 0, notDue: 0, budgetMs: null, concurrency: 1 });
        onProgress({ type: "board", state: "done", id: "a", name: "A", fetched: 5, created: 5, updated: 0, staled: 0, ms: 3 });
        onProgress({ type: "phase", phase: "boards", state: "done" });
      },
      { trigger: "scheduled", origin: "web" },
    );
    off();
    expect(ranked).toBe(true);
    expect(seen).toContain("running:boards");
    expect(seen).toContain("running:rank");
    expect(seen.at(-1)).toBe("done:-");
    const stored = await repo.listSyncRuns(5);
    expect(stored[0]).toMatchObject({ trigger: "scheduled", origin: "web", status: "done" });
    expect(stored[0]?.summary.postings.new).toBe(5);
    expect(stored[0]?.summary.message).toMatch(/Checked 1 board: 5 jobs fetched, 5 new/);
    // phases a runner never reported read as skipped, never stuck "pending"
    expect(stored[0]?.summary.phases.every((p) => p.status === "done" || p.status === "skipped")).toBe(true);
  });

  it("cancel stops the run, marks it cancelled, and still ranks what was fetched", async () => {
    const repo = new InMemoryRepository();
    let sawSignal = false;
    let ranked = false;
    const run = startCorpusSync(
      repo,
      async () => void (ranked = true),
      async (_r, { onProgress, signal }) => {
        onProgress({ type: "phase", phase: "boards", state: "start" });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        sawSignal = signal.aborted;
        onProgress({ type: "phase", phase: "boards", state: "done" });
        for (const phase of ["feeds", "resolve", "expire", "process"] as const) onProgress({ type: "phase", phase, state: "skipped" });
      },
    );
    expect(corpusSyncing()).toBe(true);
    expect(cancelCorpusSync()).toBe(true);
    await run;
    expect(sawSignal).toBe(true);
    expect(ranked).toBe(true);
    expect(corpusSyncing()).toBe(false);
    expect(cancelCorpusSync()).toBe(false);
    const status = await syncStatus(repo, "t-any");
    expect(status.current).toBeNull();
    expect(status.last).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(status.last?.message).toMatch(/^Cancelled\. .*Nothing was retired/);
    expect(status.last?.phases.find((p) => p.id === "expire")?.status).toBe("skipped");
  });

  it("status counts new matches for the caller above the threshold", async () => {
    const repo = new InMemoryRepository();
    const tenantId = (await repo.createTenant({ name: "t" })).id;
    await loadSampleProfile(repo, tenantId);
    await startCorpusSync(repo, undefined, async () => {});
    const status = await syncStatus(repo, tenantId);
    expect(status.you).toMatchObject({ ranked: true, threshold: 60, newMatches: 0 });
    expect(status.history.length).toBeGreaterThan(0);
  });
});
