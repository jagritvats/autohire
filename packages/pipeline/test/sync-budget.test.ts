import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@jobflow/core";
import { ADAPTERS } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import {
  boardLimitsForSync,
  FIRST_SYNC_MAX_BOARDS,
  FIRST_SYNC_TIME_MS,
  orderBoardsForPoll,
  pollAll,
  pollBacklog,
  syncLimitsFromEnv,
} from "../src/poll.js";
import { listPresets, getPreset } from "../src/presets/index.js";
import type { Embedder } from "../src/embedder.js";

/**
 * The per-sync board budget (audit 2026-11 follow-up): a fixed 25-board sync re-polled a
 * 240-board registry only every 5–10 days. Now a sync takes every DUE board, most overdue
 * first, inside a time budget, and a fresh registry's first sync stays capped. The
 * simulation runs the real preset registries through the real ordering and limits, with a
 * modelled fetch time per ATS and the real concurrency / per-host politeness.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEC = 1000;

interface SimBoard extends Pick<Company, "atsType" | "lastPolled" | "pollCadence"> {
  id: string;
  host: string;
  /** modelled fetch + ingest time */
  ms: number;
}

/** fetch + ingest time by ATS — Workday ~12 s a board (audit), the JSON APIs a second or two. */
const FETCH_MS: Record<string, number> = { workday: 12 * SEC, greenhouse: 1.5 * SEC, lever: 1 * SEC, ashby: 2 * SEC, other: 4 * SEC };

/** a preset's seed employers as resolved boards (ATS and host read from the careers URL). */
function registryOf(presetIds: string[]): SimBoard[] {
  const byName = new Map<string, SimBoard>();
  for (const id of presetIds) {
    for (const s of getPreset(id)!.seedCompanies) {
      const key = s.name.toLowerCase();
      const u = s.careersUrl ?? "";
      const host = (() => {
        try {
          return new URL(u).host;
        } catch {
          return `probe:${key}`;
        }
      })();
      const ats = /myworkdayjobs/.test(u) ? "workday" : /greenhouse/.test(u) ? "greenhouse" : /lever\.co/.test(u) ? "lever" : /ashby/.test(u) ? "ashby" : "other";
      // the poll's per-host key: shared JSON APIs by ATS, Workday and the rest by their own host
      const hostKey = ats === "greenhouse" || ats === "lever" || ats === "ashby" ? ats : host;
      const prev = byName.get(key);
      byName.set(key, {
        id: key,
        atsType: (ats === "other" ? "smartrecruiters" : ats) as Company["atsType"],
        host: hostKey,
        ms: FETCH_MS[ats]!,
        lastPolled: null,
        pollCadence: prev?.pollCadence === "daily" || s.pollCadence === "daily" ? "daily" : "weekly",
      });
    }
  }
  return [...byName.values()];
}

/** the repo's dueForPoll windows */
function isDue(b: SimBoard, now: number): boolean {
  if (!b.lastPolled) return true;
  const age = now - new Date(b.lastPolled).getTime();
  return b.pollCadence === "daily" ? age >= 20 * HOUR : age >= 6 * DAY;
}

/**
 * One sync: pollAll's ordering and limits, then mapPoolKeyed's scheduling (8 at once, ≤2 per
 * host) with the deadline check before each board starts. Returns the boards polled (with
 * their finish times) and how long the board phase took.
 */
function simulateRun(boards: SimBoard[], now: number, maxBoards: number | "auto", timeBudgetMs: number, order = orderBoardsForPoll<SimBoard>) {
  const due = boards.filter((b) => isDue(b, now));
  const limits = boardLimitsForSync({ maxBoards, timeBudgetMs, firstSync: !boards.some((b) => b.lastPolled) });
  const queue = order(due, limits.maxBoards, now);
  const running: Array<{ b: SimBoard; end: number }> = [];
  const perHost = new Map<string, number>();
  const polled: SimBoard[] = [];
  let t = 0;
  const pending = [...queue];
  while (pending.length || running.length) {
    // start what fits (in order, skipping hosts at their limit), unless past the deadline
    for (let j = 0; j < pending.length && running.length < 8; ) {
      const b = pending[j]!;
      if ((perHost.get(b.host) ?? 0) >= 2) {
        j++;
        continue;
      }
      pending.splice(j, 1);
      if (t > limits.timeBudgetMs) continue; // deferred: left due, untouched
      perHost.set(b.host, (perHost.get(b.host) ?? 0) + 1);
      running.push({ b, end: t + b.ms });
    }
    if (!running.length) break;
    running.sort((x, y) => x.end - y.end);
    const done = running.shift()!;
    t = done.end;
    perHost.set(done.b.host, perHost.get(done.b.host)! - 1);
    done.b.lastPolled = new Date(now + t);
    polled.push(done.b);
  }
  return { polled, ms: t, due: due.length, limits };
}

interface Schedule {
  /** hours between scheduled syncs */
  everyHours: number;
  days: number;
  maxBoards: number | "auto";
  timeBudgetMs: number;
  /** the web app's quarter-hour catch-up while boards were never polled */
  catchUp: boolean;
  order?: (boards: SimBoard[], max: number, now: number) => SimBoard[];
}

/** the order before the budget change: never-polled first, then plain oldest-first */
function oldestFirst(boards: SimBoard[], max: number): SimBoard[] {
  const t = (b: SimBoard) => (b.lastPolled ? new Date(b.lastPolled).getTime() : 0);
  return [...boards.filter((b) => !b.lastPolled), ...boards.filter((b) => b.lastPolled).sort((a, b) => t(a) - t(b))].slice(0, max);
}

function simulate(boards: SimBoard[], s: Schedule) {
  const start = Date.UTC(2026, 10, 2, 9);
  const firstPolledAt = new Map<string, number>();
  const gaps = { daily: [] as number[], weekly: [] as number[] };
  const last = new Map<string, number>();
  const runs: Array<{ at: number; polled: number; ms: number; first: boolean }> = [];
  let now = start;
  let nextScheduled = start + s.everyHours * HOUR;
  while (now < start + s.days * DAY) {
    const r = simulateRun(boards, now, s.maxBoards, s.timeBudgetMs, s.order);
    runs.push({ at: now - start, polled: r.polled.length, ms: r.ms, first: r.limits.first });
    for (const b of r.polled) {
      const at = new Date(b.lastPolled!).getTime();
      if (!firstPolledAt.has(b.id)) firstPolledAt.set(b.id, at - start);
      const prev = last.get(b.id);
      // steady state only: gaps measured once the registry's first sweep is through
      if (prev != null && prev - start > 2 * DAY) gaps[b.pollCadence === "daily" ? "daily" : "weekly"].push(at - prev);
      last.set(b.id, at);
    }
    // the next run: the schedule, or the web app's quarter-hour catch-up while boards were never polled
    const catchUpAt = s.catchUp && boards.some((b) => !b.lastPolled) ? now + 15 * 60_000 : Infinity;
    if (catchUpAt < nextScheduled) now = catchUpAt;
    else {
      now = nextScheduled;
      nextScheduled += s.everyHours * HOUR;
    }
  }
  return { firstPolledAt, gaps, runs, unpolled: boards.filter((b) => !b.lastPolled).length };
}

const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
const report = (label: string, boards: SimBoard[], r: ReturnType<typeof simulate>) => {
  if (!process.env.SIM_REPORT) return;
  const longest = max(r.runs.map((x) => x.ms));
  console.log(
    `${label}: ${boards.length} boards (${boards.filter((b) => b.pollCadence === "daily").length} daily) · first sync ${r.runs[0]!.polled} boards in ${Math.round(r.runs[0]!.ms / SEC)} s · ` +
      `all polled after ${(max([...r.firstPolledAt.values()]) / HOUR).toFixed(1)} h (${r.unpolled} never) · ` +
      `max gap daily ${(max(r.gaps.daily) / HOUR).toFixed(1)} h, weekly ${(max(r.gaps.weekly) / DAY).toFixed(2)} d · ` +
      `boards/run max ${max(r.runs.slice(1).map((x) => x.polled))} · longest board phase ${Math.round(longest / SEC)} s`,
  );
};

describe("sync board budget — simulated on the real preset registries", () => {
  it("the presets are registry-sized (the case a fixed 25-board sync couldn't keep fresh)", () => {
    expect(registryOf(["india"]).length).toBeGreaterThanOrEqual(200);
    expect(registryOf(listPresets().map((p) => p.id)).length).toBeGreaterThanOrEqual(350);
  });

  for (const [label, presets] of [
    ["india", ["india"]],
    ["every preset", listPresets().map((p) => p.id)],
  ] as const) {
    it(`${label}: a quick first sync, every board polled the same day, then every board within its cadence (web schedule)`, () => {
      const boards = registryOf([...presets]);
      const r = simulate(boards, { everyHours: 6, days: 21, maxBoards: "auto", timeBudgetMs: 5 * 60_000, catchUp: true });
      report(`web ${label}`, boards, r);
      // first sync: capped and quick
      expect(r.runs[0]!.first).toBe(true);
      expect(r.runs[0]!.polled).toBeLessThanOrEqual(FIRST_SYNC_MAX_BOARDS);
      expect(r.runs[0]!.ms).toBeLessThanOrEqual(FIRST_SYNC_TIME_MS + 12 * SEC);
      // the catch-up reaches every board within a couple of hours
      expect(r.unpolled).toBe(0);
      expect(max([...r.firstPolledAt.values()])).toBeLessThanOrEqual(3 * HOUR);
      // then: daily boards about daily (due after 20 h, next 6-hourly run), weekly within the week
      expect(max(r.gaps.daily)).toBeLessThanOrEqual(26 * HOUR + 10 * 60_000);
      expect(max(r.gaps.weekly)).toBeLessThanOrEqual(7 * DAY);
      // and no run overruns its time budget by more than the boards already in flight
      for (const run of r.runs) expect(run.ms).toBeLessThanOrEqual(5 * 60_000 + 12 * SEC);
    });

    it(`${label}: the worker every 6 h (no catch-up) reaches every board on the first day, then keeps cadence`, () => {
      const boards = registryOf([...presets]);
      const r = simulate(boards, { everyHours: 6, days: 21, maxBoards: "auto", timeBudgetMs: 10 * 60_000, catchUp: false });
      report(`worker ${label}`, boards, r);
      expect(r.unpolled).toBe(0);
      expect(max([...r.firstPolledAt.values()])).toBeLessThanOrEqual(1 * DAY);
      expect(max(r.gaps.daily)).toBeLessThanOrEqual(26 * HOUR + 10 * 60_000);
      expect(max(r.gaps.weekly)).toBeLessThanOrEqual(7 * DAY);
    });
  }

  it("a once-a-day `jobflow sync` keeps daily boards daily and weekly ones weekly", () => {
    const boards = registryOf(["india"]);
    const r = simulate(boards, { everyHours: 24, days: 21, maxBoards: "auto", timeBudgetMs: 5 * 60_000, catchUp: false });
    report("cli daily india", boards, r);
    expect(r.unpolled).toBe(0);
    expect(max(r.gaps.daily)).toBeLessThanOrEqual(24 * HOUR + 10 * 60_000);
    expect(max(r.gaps.weekly)).toBeLessThanOrEqual(7 * DAY + 10 * 60_000);
  });

  it("the old fixed 25-board, oldest-first sync could not (the audit's 5–10 day re-polls)", () => {
    const boards = registryOf(["india"]);
    const r = simulate(boards, { everyHours: 6, days: 21, maxBoards: 25, timeBudgetMs: Infinity, catchUp: false, order: oldestFirst });
    report("old 25-cap oldest-first india, 4/day", boards, r);
    expect(max(r.gaps.daily)).toBeGreaterThan(2 * DAY);
    const r2 = simulate(registryOf(["india"]), { everyHours: 12, days: 21, maxBoards: 25, timeBudgetMs: Infinity, catchUp: false, order: oldestFirst });
    report("old 25-cap oldest-first india, 2/day", boards, r2);
    expect(max(r2.gaps.daily)).toBeGreaterThan(4 * DAY);
  });

  it("under a fixed cap, lateness order keeps daily boards ahead of a weekly cohort coming due together", () => {
    const now = Date.UTC(2026, 10, 20);
    const daily = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, atsType: "lever" as const, pollCadence: "daily" as const, lastPolled: new Date(now - 26 * HOUR) }));
    const weekly = Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, atsType: "workday" as const, pollCadence: "weekly" as const, lastPolled: new Date(now - 6.2 * DAY) }));
    const picked = orderBoardsForPoll([...weekly, ...daily], 20, now).map((b) => b.id);
    // oldest-first would have taken 20 weekly boards and left every daily board waiting
    expect(picked.slice(0, 10).sort()).toEqual(daily.map((d) => d.id).sort());
  });
});

describe("sync limits", () => {
  it("auto: every due board; a fresh registry's first sync is capped and time-boxed", () => {
    expect(boardLimitsForSync({ maxBoards: "auto", timeBudgetMs: 300_000, firstSync: false })).toEqual({ maxBoards: Infinity, timeBudgetMs: 300_000, first: false });
    expect(boardLimitsForSync({ maxBoards: "auto", timeBudgetMs: 300_000, firstSync: true })).toEqual({ maxBoards: FIRST_SYNC_MAX_BOARDS, timeBudgetMs: FIRST_SYNC_TIME_MS, first: true });
    // an explicit cap is taken as given, first sync or not
    expect(boardLimitsForSync({ maxBoards: 40, timeBudgetMs: Infinity, firstSync: true })).toEqual({ maxBoards: 40, timeBudgetMs: Infinity, first: false });
  });

  it("reads JOBFLOW_SYNC_MAX_BOARDS / JOBFLOW_SYNC_MINUTES and ignores nonsense", () => {
    expect(syncLimitsFromEnv({ JOBFLOW_SYNC_MAX_BOARDS: "60", JOBFLOW_SYNC_MINUTES: "2" })).toEqual({ maxBoards: 60, timeBudgetMs: 120_000 });
    expect(syncLimitsFromEnv({ JOBFLOW_SYNC_MAX_BOARDS: "auto" })).toEqual({});
    expect(syncLimitsFromEnv({ JOBFLOW_SYNC_MAX_BOARDS: "0", JOBFLOW_SYNC_MINUTES: "-1" })).toEqual({});
    expect(syncLimitsFromEnv({ JOBFLOW_SYNC_MAX_BOARDS: "lots" })).toEqual({});
  });
});

describe("pollAll board budget (stubbed boards, no network)", () => {
  const embedder: Embedder = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });
  const original = ADAPTERS.greenhouse!.fetch;
  let fetches = 0;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    fetches = 0;
    ADAPTERS.greenhouse!.fetch = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return [];
    };
  });
  afterEach(() => {
    ADAPTERS.greenhouse!.fetch = original;
    vi.unstubAllGlobals();
  });

  const quiet = { embedder, feeds: [], customSources: false, searches: false, telegramChannels: [], discoverNewSeeds: false } as const;

  async function registry(n: number) {
    const repo = new InMemoryRepository();
    for (let i = 0; i < n; i++) {
      await repo.upsertCompany({ name: `Example ${i}`, nameNorm: `example ${i}`, atsType: "greenhouse", atsSlug: `example${i}` });
    }
    return repo;
  }

  it("the first sync stops at the first-sync cap; the next one polls the rest; then nothing is due", async () => {
    const repo = await registry(40);
    const first = await pollAll(repo, quiet);
    expect(first.companiesPolled).toBe(FIRST_SYNC_MAX_BOARDS);
    expect(first.boardsDue).toBe(40);
    expect(first.boardsDeferred).toBe(40 - FIRST_SYNC_MAX_BOARDS);
    expect((await pollBacklog(repo)).neverPolled).toBe(40 - FIRST_SYNC_MAX_BOARDS);

    const second = await pollAll(repo, quiet);
    expect(second.companiesPolled).toBe(40 - FIRST_SYNC_MAX_BOARDS);
    expect(second.boardsDeferred).toBe(0);
    expect(await pollBacklog(repo)).toEqual({ boards: 40, neverPolled: 0, due: 0 });

    const third = await pollAll(repo, quiet);
    expect(third.companiesPolled).toBe(0);
    expect(fetches).toBe(40);
  });

  it("a time budget defers the boards it didn't reach — untouched, so they lead the next run", async () => {
    const repo = await registry(12);
    await repo.touchPolled((await repo.listCompanies())[0]!.id); // not a first sync
    const r = await pollAll(repo, { ...quiet, concurrency: 1, timeBudgetMs: 50 });
    expect(r.companiesPolled).toBeGreaterThan(0);
    expect(r.companiesPolled).toBeLessThan(11);
    expect(r.boardsDeferred).toBe(11 - r.companiesPolled);
    expect((await pollBacklog(repo)).neverPolled).toBe(r.boardsDeferred);
  });

  it("an explicit cap wins over auto", async () => {
    const repo = await registry(10);
    const r = await pollAll(repo, { ...quiet, maxBoards: 4 });
    expect(r.companiesPolled).toBe(4);
    expect(r.boardsDeferred).toBe(6);
  });
});
