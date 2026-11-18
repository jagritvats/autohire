import { afterEach, describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import type { PollEvent } from "@jobflow/pipeline";
import { DEMO_JOBS, demoMode, demoSearchAdapters, demoSync, loadSampleProfile, runSync, searchJobs, seedDemoPostings } from "../src/index.js";

const ENV = { demo: process.env.JOBFLOW_DEMO_DATA, pace: process.env.JOBFLOW_DEMO_SYNC_PACE };
afterEach(() => {
  for (const [k, v] of [
    ["JOBFLOW_DEMO_DATA", ENV.demo],
    ["JOBFLOW_DEMO_SYNC_PACE", ENV.pace],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("demo mode (JOBFLOW_DEMO_DATA=1)", () => {
  it("is off unless the flag is exactly 1", () => {
    delete process.env.JOBFLOW_DEMO_DATA;
    expect(demoMode()).toBe(false);
    process.env.JOBFLOW_DEMO_DATA = "true";
    expect(demoMode()).toBe(false);
    process.env.JOBFLOW_DEMO_DATA = "1";
    expect(demoMode()).toBe(true);
  });

  it("seeds the fictional postings idempotently (a second seed creates nothing)", async () => {
    const repo = new InMemoryRepository();
    const first = await seedDemoPostings(repo);
    expect(first.created).toBe(DEMO_JOBS.length);
    const again = await seedDemoPostings(repo);
    expect(again.created).toBe(0);
    expect(again.updated).toBe(DEMO_JOBS.length);
    expect((await repo.listActivePostings()).length).toBe(DEMO_JOBS.length);
  });

  it("the demo sync reports real progress events over fictional boards, one failing in plain words", async () => {
    const repo = new InMemoryRepository();
    const events: PollEvent[] = [];
    const stats = await demoSync(repo, { onProgress: (e) => events.push(e) }, { pace: 0 });
    const plan = events.find((e) => e.type === "plan");
    expect(plan && plan.type === "plan" && plan.boards).toBe(new Set(DEMO_JOBS.map((j) => j.company)).size + 1);
    const done = events.filter((e) => e.type === "board" && e.state === "done");
    expect(done.length).toBe(plan && plan.type === "plan" ? plan.boards : -1);
    expect(done.filter((e) => e.type === "board" && e.state === "done" && e.error).length).toBe(1);
    expect(stats.fetched).toBe(DEMO_JOBS.length);
    expect(stats.staled).toBe(0);
    // the real offline estimator prices the postings that state no pay
    expect(stats.salaryEstimated).toBeGreaterThan(0);
    expect((await repo.listActivePostings()).length).toBe(DEMO_JOBS.length);
  });

  it("a cancelled demo sync starts no new board and retires nothing", async () => {
    const repo = new InMemoryRepository();
    const ac = new AbortController();
    ac.abort();
    const events: PollEvent[] = [];
    const stats = await demoSync(repo, { onProgress: (e) => events.push(e), signal: ac.signal }, { pace: 0 });
    expect(stats.cancelled).toBe(true);
    expect(events.some((e) => e.type === "board" && e.state === "start")).toBe(false);
    expect(events.some((e) => e.type === "phase" && e.phase === "expire" && e.state === "skipped")).toBe(true);
  });

  it("runSync uses the demo sync only in demo mode", async () => {
    process.env.JOBFLOW_DEMO_DATA = "1";
    process.env.JOBFLOW_DEMO_SYNC_PACE = "0";
    const repo = new InMemoryRepository();
    await loadSampleProfile(repo, "t1");
    const r = await runSync(repo, "t1");
    expect(r.progress.status).toBe("done");
    expect(r.progress.boards.failed).toBe(1);
    expect(r.ranked).toBe(true);
    expect((await repo.listMatches("t1", 100)).length).toBeGreaterThan(0);
  });

  it("search in demo mode answers from the fictional boards only", async () => {
    process.env.JOBFLOW_DEMO_DATA = "1";
    const repo = new InMemoryRepository();
    await loadSampleProfile(repo, "t1");
    const out = await searchJobs(repo, "t1", { keywords: ["kafka"] });
    expect(out.cards.length).toBeGreaterThan(0);
    const companies = new Set(DEMO_JOBS.map((j) => j.company));
    for (const c of out.cards) expect(companies.has(c.company)).toBe(true);
    expect(demoSearchAdapters().every((a) => a.tier === "tier1")).toBe(true);
  });
});
