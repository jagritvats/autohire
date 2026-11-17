import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { normCompany, normalizePosting, type RawPosting } from "@jobflow/core";
import { toNewPosting } from "@jobflow/pipeline";
import { getFeed, loadSampleProfile, rankTenant, ensureTenant } from "../src/index.js";

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });

async function seedPosting(repo: InMemoryRepository, title: string, jd: string) {
  const company = await repo.upsertCompany({ name: "Acme Payments", nameNorm: normCompany("Acme Payments"), atsType: "greenhouse", atsSlug: "acme" });
  const raw: RawPosting = {
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: `${title}-1`, companyName: company.name,
    companySlug: "acme", title, jdText: jd, jdHtml: null, locationRaw: "Remote", applyUrl: "https://example.com/apply",
    salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
  };
  return repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embed));
}

describe("feed (service)", () => {
  it("before onboarding: an unscored browse feed, never invented fit scores", async () => {
    const repo = new InMemoryRepository();
    const tenant = await repo.createTenant({ name: "t" });
    await seedPosting(repo, "Backend Engineer", "Java, Kafka, Postgres. Remote.");
    const feed = await getFeed(repo, tenant.id, { bootstrap: false });
    expect(feed.stats.mode).toBe("browse");
    expect(feed.stats.needsOnboarding).toBe(true);
    expect(feed.cards).toHaveLength(1);
    expect(feed.cards[0]!.score).toBe(0);
    expect(await rankTenant(repo, tenant.id)).toBe(false);
    expect(await repo.listMatches(tenant.id)).toHaveLength(0);
  });

  it("after onboarding: ranked, and one tenant's matches never appear in another's feed", async () => {
    const repo = new InMemoryRepository();
    const a = await repo.createTenant({ name: "a" });
    const b = await repo.createTenant({ name: "b" });
    await seedPosting(repo, "Backend Engineer", "Java, Kafka, Postgres, distributed systems. Remote worldwide.");
    await ensureTenant(repo, b.id);
    await loadSampleProfile(repo, a.id);
    expect(await rankTenant(repo, a.id)).toBe(true);

    const feedA = await getFeed(repo, a.id, { bootstrap: false });
    expect(feedA.stats.mode).toBe("ranked");
    expect(feedA.cards[0]!.score).toBeGreaterThan(0);

    const feedB = await getFeed(repo, b.id, { bootstrap: false });
    expect(feedB.stats.mode).toBe("browse");
    expect(await repo.listMatches(b.id)).toHaveLength(0);
  });

  it("a new tenant starts blank — never as a built-in persona", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await ensureTenant(repo, t.id);
    const p = await repo.getProfile(t.id);
    expect(p?.masterResume).toBe("");
    expect(p?.onboardedAt).toBeNull();
    expect(await repo.listEvidence(t.id)).toHaveLength(0);
  });
});
