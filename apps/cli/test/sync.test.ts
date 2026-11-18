import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import type { SyncRunner } from "@jobflow/service";
import { bar, etaWords } from "../src/render/sync-progress.js";
import { fakeFetch, run, tempDir } from "./helpers.js";

/**
 * `jobflow sync` progress without a TTY (CI, a pipe, a log): plain phase lines on stderr, the
 * summary on stdout; with --json, JSON-lines progress on stderr and ONE summary document on
 * stdout. The poll is a scripted fake — no network.
 */

const scripted: SyncRunner = async (_repo, { onProgress }) => {
  onProgress({ type: "phase", phase: "discover", state: "skipped" });
  // the pipeline's order: the plan, then the phase starts
  onProgress({ type: "plan", boards: 3, deferred: 1, notDue: 4, budgetMs: 300_000, concurrency: 2 });
  onProgress({ type: "phase", phase: "boards", state: "start" });
  for (const [i, name] of ["Example One", "Example Two", "Example Three"].entries()) {
    onProgress({ type: "board", state: "start", id: String(i), name });
    if (i === 2) onProgress({ type: "board", state: "done", id: String(i), name, fetched: 0, created: 0, updated: 0, staled: 0, ms: 50, error: "HTTP 429 Too Many Requests" });
    else onProgress({ type: "board", state: "done", id: String(i), name, fetched: 6, created: 4, updated: 2, staled: 1, ms: 40 });
  }
  onProgress({ type: "phase", phase: "boards", state: "done" });
  onProgress({ type: "feeds", total: 1 });
  onProgress({ type: "phase", phase: "feeds", state: "start" });
  onProgress({ type: "source", state: "start", key: "feed:remotive", label: "remotive", kind: "feed" });
  onProgress({ type: "source", state: "done", key: "feed:remotive", fetched: 3, created: 1, ms: 20 });
  onProgress({ type: "phase", phase: "feeds", state: "done" });
  for (const phase of ["resolve", "expire", "process"] as const) {
    onProgress({ type: "phase", phase, state: "start" });
    onProgress({ type: "phase", phase, state: "done" });
  }
  return { companiesPolled: 2, fetched: 15, staled: 2, feeds: { remotive: 3 }, resolved: [], expired: 0, errors: ["Example Three: HTTP 429"] };
};

let tmp: ReturnType<typeof tempDir>;
let repo: InMemoryRepository;
beforeEach(() => {
  tmp = tempDir();
  repo = new InMemoryRepository();
  vi.stubGlobal("fetch", fakeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  tmp.cleanup();
});

describe("jobflow sync progress", () => {
  it("without a TTY: phase lines on stderr, a plain summary on stdout", async () => {
    const r = await run(["sync"], { dataDir: tmp.dir, repo, sync: scripted });
    expect(r.code).toBe(0);
    // no cursor movement or spinner frames in a log
    expect(r.err).not.toMatch(/\x1b\[/);
    expect(r.err).toContain("→ Check job boards (3 boards, 4 not due yet)");
    expect(r.err).toContain("✓ Check job boards");
    expect(r.err).toContain("- Find new companies: skipped");
    expect(r.err).toMatch(/boards 3\/3 \(1 failed\) · 12 fetched, 8 new/);
    expect(r.err).toContain("→ Read feeds and searches (1)");
    expect(r.err).toContain("Example Three: asked us to slow down (rate limited)");
    expect(r.out).toMatch(/Checked 3 boards and 1 feed: 15 jobs fetched, 9 new, 2 closed\. 1 board waits for the next sync\./);
    expect(r.out).toContain("Your corpus:");
  });

  it("--json: one summary document on stdout, JSON-lines progress on stderr", async () => {
    const r = await run(["--json", "sync"], { dataDir: tmp.dir, repo, sync: scripted });
    expect(r.code).toBe(0);
    const doc = r.json();
    expect(doc).toMatchObject({ status: "done", newPostings: 9, ranked: false, newMatches: 0, matchThreshold: 60, companiesPolled: 2 });
    expect(doc.run.boards).toMatchObject({ total: 3, done: 2, failed: 1, deferred: 1, notDue: 4 });
    expect(doc.run.errors[0]).toEqual({ source: "Example Three", message: expect.stringMatching(/rate limited/) });
    const events = r.err
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThan(2);
    expect(events.every((e) => e.type === "sync.progress")).toBe(true);
    expect(events.some((e) => e.phase === "boards")).toBe(true);
    expect(events.at(-1).status).toBe("done");
  });

  it("draws a bar and rounds the time left", () => {
    expect(bar(0.5, 10)).toBe("█████░░░░░");
    expect(bar(2, 4)).toBe("████");
    expect(etaWords(null)).toBeNull();
    expect(etaWords(5_000)).toBe("almost done");
    expect(etaWords(150_000)).toBe("~3 min left");
  });
});
