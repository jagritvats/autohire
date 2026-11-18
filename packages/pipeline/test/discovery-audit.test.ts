import { describe, expect, it, vi } from "vitest";
import { normalizePosting, type Company, type RawPosting } from "@jobflow/core";
import { InMemoryRepository } from "@jobflow/db";

// harvest resolves links through the live detector — answer from a fixture instead
vi.mock("@jobflow/adapters", async (importOriginal) => {
  const real = await importOriginal<typeof import("@jobflow/adapters")>();
  return {
    ...real,
    detectFromUrl: async (url: string) =>
      url.includes("myworkdayjobs")
        ? { atsType: "workday", atsSlug: "acmecorp.wd5.myworkdayjobs.com/acmecorp/External", confidence: "confirmed" }
        : null,
  };
});

const { orderBoardsForPoll, expireUnseenBoardPostings, BOARD_TTL_DAYS } = await import("../src/poll.js");
const { prioritizeWorkable, toNewPosting } = await import("../src/ingest.js");
const { harvestLinks } = await import("../src/harvest.js");
const { rebuildMatches } = await import("../src/match.js");
const { sampleProfile } = await import("../src/sample.js");

/**
 * Regression cases from the 2026-11 discovery audit (docs/internal/DISCOVERY_AUDIT.md),
 * minimised and fictionalised. No live HTTP.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Board = Pick<Company, "atsType" | "lastPolled" | "pollCadence"> & { id: string };

function board(id: string, atsType: Company["atsType"], pollCadence: Company["pollCadence"] = "weekly"): Board {
  return { id, atsType, pollCadence, lastPolled: null };
}

/** the repo's dueForPoll windows */
function due(b: Board, now: number): boolean {
  if (!b.lastPolled) return true;
  const age = now - new Date(b.lastPolled).getTime();
  return b.pollCadence === "daily" ? age >= 20 * HOUR : age >= 6 * DAY;
}

describe("poll scheduling reaches every board (168 of 247 boards unpolled after a full sync)", () => {
  it("a fresh registry is fully polled within ceil(boards / cap) runs, and daily boards keep their cadence", () => {
    // 120 boards, most on one ATS (the live registry was 113 of 247 Workday), 12 daily
    const boards: Board[] = [];
    for (let i = 0; i < 90; i++) boards.push(board(`wd${i}`, "workday"));
    for (let i = 0; i < 18; i++) boards.push(board(`gh${i}`, "greenhouse"));
    for (let i = 0; i < 12; i++) boards.push(board(`daily${i}`, i % 2 ? "lever" : "ashby", "daily"));
    const cap = 25; // the default `jobflow sync`
    let now = Date.UTC(2026, 10, 1);
    const firstPolledRun = new Map<string, number>();
    const lateDailyGaps: number[] = [];
    const lastDaily = new Map<string, number>();
    let firstRunAts = new Set<string>();
    for (let run = 1; run <= 14; run++) {
      const picked = orderBoardsForPoll(boards.filter((b) => due(b, now)), cap);
      expect(picked.length).toBeLessThanOrEqual(cap);
      if (run === 1) firstRunAts = new Set(picked.map((b) => b.atsType));
      for (const b of picked) {
        if (!firstPolledRun.has(b.id)) firstPolledRun.set(b.id, run);
        if (b.pollCadence === "daily") {
          if (lastDaily.has(b.id) && run > 8) lateDailyGaps.push(now - lastDaily.get(b.id)!);
          lastDaily.set(b.id, now);
        }
        b.lastPolled = new Date(now);
      }
      now += 12 * HOUR; // two syncs a day
    }
    // every board within ceil(boards / cap) runs (oldest-first stays the fair order)
    expect(firstPolledRun.size).toBe(boards.length);
    expect(Math.max(...firstPolledRun.values())).toBeLessThanOrEqual(Math.ceil(boards.length / cap));
    // the daily (high-value) boards go first; the first sweep reaches every ATS family
    for (let i = 0; i < 12; i++) expect(firstPolledRun.get(`daily${i}`)).toBe(1);
    expect([...firstRunAts].sort()).toEqual(["ashby", "greenhouse", "lever", "workday"]);
    // once the backlog is through, daily boards come round about daily
    expect(Math.max(...lateDailyGaps)).toBeLessThanOrEqual(DAY);
  });

  it("orders never-polled (daily first, round-robin by ATS) before the least recently polled", () => {
    const now = Date.UTC(2026, 10, 10);
    const old = { ...board("old", "lever"), lastPolled: new Date(now - 9 * DAY) };
    const recent = { ...board("recent", "greenhouse", "daily"), lastPolled: new Date(now - 30 * HOUR) };
    const fresh = [board("n1", "workday"), board("n2", "workday"), board("n3", "ashby"), board("nd", "workday", "daily")];
    const order = orderBoardsForPoll([recent, ...fresh, old], 6).map((b) => b.id);
    expect(order).toEqual(["nd", "n1", "n3", "n2", "old", "recent"]);
  });
});

function raw(over: Partial<RawPosting>): RawPosting {
  return {
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "1", companyName: "Acme Corp", companySlug: "acmecorp",
    title: "Backend Engineer", jdText: "Build services in Java and Postgres.", jdHtml: null, locationRaw: "Bengaluru, India",
    applyUrl: null, salaryRaw: null, postedAt: null, fetchedAt: new Date(), raw: {}, ...over,
  } as RawPosting;
}

const embed = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });

async function seedPosting(repo: InMemoryRepository, company: Company, id: string, title = "Backend Engineer") {
  const n = normalizePosting(raw({ atsJobId: id, title, companyName: company.name }));
  return repo.upsertPosting(await toNewPosting(n, company.id, company.name, embed));
}

describe("the board TTL sweep only retires what a fetch could have confirmed (invariant #5)", () => {
  it("keeps postings of a board the per-run cap hasn't reached; retires them once the board was fetched without them", async () => {
    const repo = new InMemoryRepository();
    const now = Date.now();
    const old = new Date(now - (BOARD_TTL_DAYS + 5) * DAY);
    const unreached = await repo.upsertCompany({ name: "Unreached", nameNorm: "unreached", atsType: "greenhouse", atsSlug: "unreached" });
    const refetched = await repo.upsertCompany({ name: "Refetched", nameNorm: "refetched", atsType: "greenhouse", atsSlug: "refetched" });
    const paused = await repo.upsertCompany({ name: "Paused", nameNorm: "paused", atsType: "greenhouse", atsSlug: "paused" });
    const a = await seedPosting(repo, unreached, "a");
    const b = await seedPosting(repo, refetched, "b");
    const c = await seedPosting(repo, paused, "c");
    for (const p of [a, b, c]) (await repo.getPosting(p.id))!.lastSeen = old;
    // unreached: last polled BEFORE the posting was last seen (cap rotation still under way)
    (await repo.getCompany(unreached.id))!.lastPolled = new Date(old.getTime() - DAY);
    // refetched: the board was fetched yesterday (empty / partial) and the posting wasn't in it
    (await repo.getCompany(refetched.id))!.lastPolled = new Date(now - DAY);
    await repo.updateCompany(paused.id, { status: "paused" });

    expect(await expireUnseenBoardPostings(repo, now)).toBe(2);
    expect((await repo.getPosting(a.id))!.isActive).toBe(true);
    expect((await repo.getPosting(b.id))!.isActive).toBe(false);
    expect((await repo.getPosting(c.id))!.isActive).toBe(false);
  });
});

describe("a capped board poll lands new roles instead of re-upserting the same first N", () => {
  it("puts roles we don't hold yet first, workable ones first", () => {
    const raws = [
      raw({ atsJobId: "held-in", locationRaw: "Pune, India" }),
      raw({ atsJobId: "new-us", locationRaw: "Austin, TX" }),
      raw({ atsJobId: "new-in", locationRaw: "Bengaluru, India" }),
      raw({ atsJobId: "held-us", locationRaw: "Seattle, WA" }),
    ];
    const order = prioritizeWorkable(raws, ["IN"], new Set(["held-in", "held-us"])).map((r) => r.atsJobId);
    expect(order).toEqual(["new-in", "held-in", "new-us", "held-us"]);
  });
});

describe("harvested links to a board we already hold don't register it twice", () => {
  it("re-tags the existing company instead of adding 'Acmecorp' next to 'Acme Corp'", async () => {
    const repo = new InMemoryRepository();
    await repo.upsertCompany({
      name: "Acme Corp", nameNorm: "acme corp", atsType: "workday", atsSlug: "acmecorp.wd5.myworkdayjobs.com/acmecorp/External", tags: ["global"],
    });
    const h = await harvestLinks(repo, [{ text: "Acme hiring SDE-2 https://acmecorp.wd5.myworkdayjobs.com/External/job/123", postedAt: new Date() }], {
      origin: "telegram:examplechannel",
    });
    const all = await repo.listCompanies();
    expect(all).toHaveLength(1);
    expect(all[0]!.tags).toEqual(expect.arrayContaining(["global", "community", "telegram:examplechannel"]));
    expect(h.boards).toEqual(["Acme Corp → workday/acmecorp.wd5.myworkdayjobs.com/acmecorp/External"]);
  });
});

describe("ranking clears a stale canonical pointer", () => {
  it("a posting that is its own canonical again loses canonicalId (the browse feed hides pointers)", async () => {
    const repo = new InMemoryRepository();
    const co = await repo.upsertCompany({ name: "Acme Corp", nameNorm: "acme corp", atsType: "greenhouse", atsSlug: "acmecorp" });
    const p1 = await seedPosting(repo, co, "1", "Software Engineer, Payments");
    const p2 = await seedPosting(repo, co, "2", "Software Engineer, Search");
    // what the old title-family key left behind: p2 pointing at p1
    await repo.setCanonical(p2.id, p1.id);
    await rebuildMatches(repo, sampleProfile(), { embedder: embed });
    expect((await repo.getPosting(p2.id))!.canonicalId).toBeNull();
    expect((await repo.getPosting(p1.id))!.canonicalId).toBeNull();
  });
});
