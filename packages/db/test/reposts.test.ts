import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../src/memory.js";
import type { NewPosting } from "../src/repository.js";

/** Upsert date semantics shared with PgRepository (least(posted_at), re-date = repost). */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

function newPosting(over: Partial<NewPosting> = {}): NewPosting {
  return {
    companyId: "c1", companyName: "Acme", atsType: "oracle", atsJobId: "500", source: "oracle", tier: "tier2",
    title: "Backend Engineer", titleNorm: "backend-engineer", roleArchetype: "backend", levelBand: "mid",
    jdText: "build things", jdSkills: ["java"], requirements: [],
    location: { mode: "onsite", city: "Bengaluru", country: "India", timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 },
    salary: { min: null, max: null, currency: "INR", source: "none", confidence: "low" },
    experience: { min: null, max: null }, applyUrl: null, jdEmbedding: null,
    dedupKey: "acme|backend-engineer|onsite:bengaluru",
    ...over,
  };
}

describe("posting upsert keeps the original publish date (§3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("a repost's later date never replaces the earlier one, and counts once as a repost", async () => {
    const repo = new InMemoryRepository();
    await repo.upsertPosting(newPosting({ postedAt: new Date(T0 - 20 * DAY).toISOString() }));

    vi.setSystemTime(T0 + 10 * DAY); // board re-stamps the req between polls
    let p = await repo.upsertPosting(newPosting({ postedAt: new Date(T0 + 9 * DAY).toISOString() }));
    expect(new Date(p.postedAt!).getTime()).toBe(T0 - 20 * DAY);
    expect(p.repostCount).toBe(1);

    vi.setSystemTime(T0 + 11 * DAY); // same re-stamped date on the next poll: not a second repost
    p = await repo.upsertPosting(newPosting({ postedAt: new Date(T0 + 9 * DAY).toISOString() }));
    expect(p.repostCount).toBe(1);
  });

  it("a relative 'Posted 30+ Days Ago' drifting forward is not a repost", async () => {
    const repo = new InMemoryRepository();
    await repo.upsertPosting(newPosting({ postedAt: new Date(T0 - 30 * DAY).toISOString() }));
    vi.setSystemTime(T0 + 8 * DAY);
    const p = await repo.upsertPosting(newPosting({ postedAt: new Date(T0 - 22 * DAY).toISOString() }));
    expect(p.repostCount).toBe(0);
    expect(new Date(p.postedAt!).getTime()).toBe(T0 - 30 * DAY);
  });

  it("a source that stops sending a date keeps the one we have", async () => {
    const repo = new InMemoryRepository();
    await repo.upsertPosting(newPosting({ postedAt: new Date(T0 - 5 * DAY).toISOString() }));
    const p = await repo.upsertPosting(newPosting({ postedAt: null }));
    expect(new Date(p.postedAt!).getTime()).toBe(T0 - 5 * DAY);
  });
});

describe("retire + lookup helpers", () => {
  it("retirePostings soft-deletes only what it's given and leaves invalidated ones invalidated", async () => {
    const repo = new InMemoryRepository();
    const a = await repo.upsertPosting(newPosting({ atsJobId: "1" }));
    const b = await repo.upsertPosting(newPosting({ atsJobId: "2" }));
    const c = await repo.upsertPosting(newPosting({ atsJobId: "3" }));
    await repo.invalidatePosting(c.id, "spam");
    expect(await repo.retirePostings([a.id, c.id])).toBe(2);
    expect((await repo.getPosting(a.id))?.status).toBe("stale");
    expect((await repo.getPosting(b.id))?.isActive).toBe(true);
    expect((await repo.getPosting(c.id))?.status).toBe("invalidated");
    expect(await repo.retirePostings([a.id])).toBe(0); // already retired
  });

  it("findPostingsByAtsIds returns stored rows for the keys, any status", async () => {
    const repo = new InMemoryRepository();
    await repo.upsertPosting(newPosting({ atsJobId: "1", embedKey: "local-v1:abc" }));
    const found = await repo.findPostingsByAtsIds("oracle", ["1", "404"]);
    expect(found.map((p) => p.embedKey)).toEqual(["local-v1:abc"]);
    expect(await repo.findPostingsByAtsIds("greenhouse", ["1"])).toEqual([]);
  });
});
