import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { normCompany, normalizePosting, type Match, type RawPosting } from "@jobflow/core";
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

describe("feed company spread (an order, never a score — invariant #4)", () => {
  async function seedAt(repo: InMemoryRepository, company: string, id: string) {
    const slug = normCompany(company).replace(/\W/g, "");
    const co = await repo.upsertCompany({ name: company, nameNorm: normCompany(company), atsType: "greenhouse", atsSlug: slug });
    const raw: RawPosting = {
      source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: id, companyName: company,
      companySlug: slug, title: `Backend Engineer ${id}`, jdText: "Java, Kafka, Postgres. Remote.", jdHtml: null, locationRaw: "Remote",
      applyUrl: "https://example.com/apply", salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
    };
    return repo.upsertPosting(await toNewPosting(normalizePosting(raw), co.id, co.name, embed));
  }

  it("at most 3 cards per company in any 20, the rest later, every card at its true score; opt out for score order", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await loadSampleProfile(repo, t.id);
    const scores = new Map<string, number>();
    const matches: Match[] = [];
    // one employer holds the 12 best scores, then 18 other companies — all near-equal
    // (95…86): the spread trades places only within DIVERSIFY_MAX_SCORE_GAP (feed-cards.test)
    for (let i = 0; i < 30; i++) {
      const p = await seedAt(repo, i < 12 ? "Example Corp" : `Other Co ${i}`, `job-${i}`);
      const score = 95 - Math.floor(i / 3);
      scores.set(p.id, score);
      matches.push({
        id: `m-${i}`, tenantId: t.id, postingId: p.id, score, rulePass: true, whyFit: null, gap: null, stackNote: null, levelNote: null, redFlags: [],
        scoreBreakdown: { semantic: 0, stackAdjacency: 0, archetype: 0, seniority: 0, location: 0, freshness: 0, salary: 0, sourceTrust: 0 },
        generatedAt: new Date(),
      });
    }
    await repo.saveMatches(matches);

    const spread = await getFeed(repo, t.id, { bootstrap: false });
    expect(spread.cards).toHaveLength(30);
    expect(spread.cards.slice(0, 20).filter((c) => c.company === "Example Corp")).toHaveLength(3);
    expect(spread.cards[0]!.score).toBe(95);
    for (const c of spread.cards) expect(c.score).toBe(scores.get(c.id));

    const byScore = await getFeed(repo, t.id, { bootstrap: false, diversify: false });
    expect(byScore.cards.map((c) => c.score)).toEqual([...scores.values()].sort((a, b) => b - a));
    expect(byScore.cards.slice(0, 12).every((c) => c.company === "Example Corp")).toBe(true);
    expect(new Set(byScore.cards.map((c) => c.id))).toEqual(new Set(spread.cards.map((c) => c.id)));
  });
});
