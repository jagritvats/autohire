import { describe, it, expect } from "vitest";
import type { Match } from "@jobflow/core";
import { InMemoryRepository } from "../src/memory.js";
import type { NewPosting } from "../src/repository.js";

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";

function newPosting(over: Partial<NewPosting> = {}): NewPosting {
  return {
    companyId: "c1",
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: "1",
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "backend-engineer",
    roleArchetype: "backend",
    levelBand: "mid",
    jdText: "build things",
    jdSkills: ["go", "postgres"],
    requirements: [],
    location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null },
    salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
    applyUrl: null,
    jdEmbedding: null,
    dedupKey: "acme|backend-engineer|remote:worldwide",
    ...over,
  };
}

async function seedCompany(repo: InMemoryRepository) {
  return repo.upsertCompany({ name: "Acme", nameNorm: "acme", atsType: "greenhouse", atsSlug: "acme" });
}

/** A rule-passing match so the posting shows up in listMatches (the feed query). */
async function seedMatch(repo: InMemoryRepository, tenantId: string, postingId: string, score = 80): Promise<void> {
  const m: Match = {
    id: `m-${postingId}`,
    tenantId,
    postingId,
    score,
    scoreBreakdown: { semantic: 0, stackAdjacency: 0, archetype: 0, seniority: 0, location: 0, freshness: 0, salary: 0 },
    rulePass: true,
    whyFit: null,
    gap: null,
    stackNote: null,
    levelNote: null,
    redFlags: [],
    generatedAt: new Date(),
  };
  await repo.saveMatches([m]);
}

describe("posting lifecycle — new postings default to active", () => {
  it("upsert assigns status='active' and the feed sees it", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));
    expect(p.status).toBe("active");
    expect(p.invalidReason).toBeNull();
    expect((await repo.listActivePostings()).map((x) => x.id)).toContain(p.id);
  });
});

describe("invalidate / revalidate (global, reversible)", () => {
  it("excludes an invalidated posting from feed + active, then restores it", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));
    await seedMatch(repo, T1, p.id);

    expect((await repo.listMatches(T1)).map((m) => m.postingId)).toContain(p.id);

    await repo.invalidatePosting(p.id, "duplicate");
    const inv = await repo.getPosting(p.id);
    expect(inv?.status).toBe("invalidated");
    expect(inv?.invalidReason).toBe("duplicate");
    expect(inv?.invalidatedAt).not.toBeNull();
    expect((await repo.listActivePostings()).map((x) => x.id)).not.toContain(p.id);
    expect((await repo.listMatches(T1)).map((m) => m.postingId)).not.toContain(p.id);
    expect((await repo.listInvalidatedPostings()).map((x) => x.id)).toContain(p.id);

    await repo.revalidatePosting(p.id);
    const back = await repo.getPosting(p.id);
    expect(back?.status).toBe("active");
    expect(back?.invalidReason).toBeNull();
    expect((await repo.listMatches(T1)).map((m) => m.postingId)).toContain(p.id);
  });
});

describe("archive (tenant-scoped overlay)", () => {
  it("hides from THIS tenant's feed but not another tenant's; unarchive restores", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));
    await seedMatch(repo, T1, p.id);
    await seedMatch(repo, T2, p.id);

    await repo.setPostingArchived(T1, p.id, true);
    expect((await repo.listMatches(T1)).map((m) => m.postingId)).not.toContain(p.id);
    // other tenant is unaffected — archival is per-user
    expect((await repo.listMatches(T2)).map((m) => m.postingId)).toContain(p.id);
    expect((await repo.listArchivedPostings(T1)).map((x) => x.id)).toContain(p.id);
    expect((await repo.listArchivedPostings(T2)).length).toBe(0);
    // still globally active (archival ≠ invalidation)
    expect((await repo.listActivePostings()).map((x) => x.id)).toContain(p.id);

    await repo.setPostingArchived(T1, p.id, false);
    expect((await repo.listMatches(T1)).map((m) => m.postingId)).toContain(p.id);
  });
});

describe("bookmarks (tenant-scoped overlay)", () => {
  it("bookmark stays in the feed and appears in the bookmarks view; scoped per tenant", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));
    await seedMatch(repo, T1, p.id);

    await repo.setPostingBookmarked(T1, p.id, true);
    expect((await repo.listMatches(T1)).map((m) => m.postingId)).toContain(p.id); // not hidden
    expect((await repo.listBookmarkedPostings(T1)).map((x) => x.id)).toContain(p.id);
    expect((await repo.getPostingUserState(T1)).bookmarked.has(p.id)).toBe(true);
    expect((await repo.listBookmarkedPostings(T2)).length).toBe(0);

    await repo.setPostingBookmarked(T1, p.id, false);
    expect((await repo.listBookmarkedPostings(T1)).length).toBe(0);
  });
});

describe("markStale + re-seen freshness (invariant #5)", () => {
  it("markStale sets status='stale'; re-upsert clears staleness but preserves invalidation", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));

    // company polled but this posting gone → stale
    await repo.markStale(co.id, ["999"]);
    expect((await repo.getPosting(p.id))?.status).toBe("stale");
    expect((await repo.getPosting(p.id))?.isActive).toBe(false);

    // re-seen in a later poll → back to active
    const again = await repo.upsertPosting(newPosting({ companyId: co.id }));
    expect(again.status).toBe("active");
    expect(again.isActive).toBe(true);

    // a manual invalidation survives a re-poll (it's a human decision)
    await repo.invalidatePosting(p.id, "spam");
    await repo.upsertPosting(newPosting({ companyId: co.id }));
    expect((await repo.getPosting(p.id))?.status).toBe("invalidated");
  });
});

describe("purgeOldPostings (remove older entries)", () => {
  it("soft-deletes postings older than a threshold but never invalidated ones", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const old = await repo.upsertPosting(newPosting({ companyId: co.id, atsJobId: "old", dedupKey: "acme|old" }));
    const fresh = await repo.upsertPosting(newPosting({ companyId: co.id, atsJobId: "fresh", dedupKey: "acme|fresh" }));
    const kept = await repo.upsertPosting(newPosting({ companyId: co.id, atsJobId: "kept", dedupKey: "acme|kept" }));

    // backdate two of them past the threshold
    (await repo.getPosting(old.id))!.lastSeen = new Date(Date.now() - 40 * 86_400_000);
    (await repo.getPosting(kept.id))!.lastSeen = new Date(Date.now() - 40 * 86_400_000);
    await repo.invalidatePosting(kept.id, "keep me out of purge"); // manual decision outranks age

    const n = await repo.purgeOldPostings({ olderThanDays: 30, field: "lastSeen" });
    expect(n).toBe(1); // only `old`
    expect((await repo.getPosting(old.id))?.status).toBe("stale");
    expect((await repo.getPosting(old.id))?.isActive).toBe(false);
    expect((await repo.getPosting(fresh.id))?.status).toBe("active"); // untouched (fresh)
    expect((await repo.getPosting(kept.id))?.status).toBe("invalidated"); // untouched (invalidated)
  });

  it("hard purge deletes the rows", async () => {
    const repo = new InMemoryRepository();
    const co = await seedCompany(repo);
    const p = await repo.upsertPosting(newPosting({ companyId: co.id }));
    (await repo.getPosting(p.id))!.lastSeen = new Date(Date.now() - 40 * 86_400_000);
    const n = await repo.purgeOldPostings({ olderThanDays: 30, hard: true });
    expect(n).toBe(1);
    expect(await repo.getPosting(p.id)).toBeNull();
  });
});
