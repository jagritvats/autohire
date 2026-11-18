import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { normCompany, normalizePosting, type RawPosting } from "@jobflow/core";
import { toNewPosting } from "@jobflow/pipeline";
import { corpusSyncing, getFeed, getJob, JobNotFoundError, startCorpusSync, loadSampleProfile, rankTenant, saveSearch, setupProgress, toCards, trackApplication } from "../src/index.js";

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });

async function seedPosting(repo: InMemoryRepository, title: string, jd: string) {
  const company = await repo.upsertCompany({ name: "Acme Payments", nameNorm: normCompany("Acme Payments"), atsType: "greenhouse", atsSlug: "acme" });
  await repo.touchPolled(company.id);
  const raw: RawPosting = {
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: `${title}-1`, companyName: company.name,
    companySlug: "acme", title, jdText: jd, jdHtml: null, locationRaw: "Remote", applyUrl: "https://example.com/apply",
    salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
  };
  return repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embed));
}

describe("setupProgress (the first-run checklist)", () => {
  it("walks profile → sync → saved search → tracked application, one next step at a time", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });

    let p = await setupProgress(repo, t.id);
    expect(p.steps.map((s) => s.id)).toEqual(["profile", "sync", "search", "track"]);
    expect(p.done).toBe(0);
    expect(p.next?.id).toBe("profile");
    expect(p.next?.cli).toBe("jobflow init");
    expect(p.profile.onboarded).toBe(false);
    expect(p.model.configured).toBe(false);

    await loadSampleProfile(repo, t.id);
    p = await setupProgress(repo, t.id);
    expect(p.next?.id).toBe("sync");

    const posting = await seedPosting(repo, "Backend Engineer", "Java, Kafka, Postgres. Remote worldwide.");
    await rankTenant(repo, t.id);
    p = await setupProgress(repo, t.id);
    expect(p.next?.id).toBe("search");
    expect(p.corpus.postings).toBe(1);
    expect(p.corpus.matches).toBe(1);
    expect(p.corpus.lastSyncAt).not.toBeNull();

    await saveSearch(repo, t.id, { name: "remote", query: { keywords: ["backend"] } });
    p = await setupProgress(repo, t.id);
    expect(p.next?.id).toBe("track");

    await trackApplication(repo, t.id, posting.id, { status: "saved", nextAction: "follow up", nextActionAt: new Date(Date.now() - 1000) });
    p = await setupProgress(repo, t.id);
    expect(p.complete).toBe(true);
    expect(p.next).toBeNull();
    expect(p.applications).toEqual({ total: 1, applied: 0, dueFollowUps: 1 });
  });
});

describe("getJob (the job page)", () => {
  it("before onboarding: unscored, no fit notes, no experience verdict — and an honest apply checklist", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    const posting = await seedPosting(repo, "Senior Backend Engineer", "Senior role. 6+ years of experience. Java, Kafka. Remote.");
    const job = await getJob(repo, null, t.id, posting.id);
    expect(job.scored).toBe(false);
    expect(job.card.score).toBe(0);
    expect(job.card.stackNote).toBeNull();
    expect(job.card.levelNote).toBeNull();
    expect(job.card.experience.fit).toBeNull(); // no candidate to compare 6+ yrs against
    expect(job.description).toContain("Kafka");
    expect(job.apply.missing).toEqual(expect.arrayContaining(["email", "name", "resume"]));
    expect(job.application).toBeNull();
  });

  it("after onboarding: scored, with the tracker row and what the filler would type", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await loadSampleProfile(repo, t.id);
    const posting = await seedPosting(repo, "Backend Engineer", "Java, Kafka, Postgres. Remote worldwide.");
    await rankTenant(repo, t.id);
    await trackApplication(repo, t.id, posting.id, { status: "ready" });
    const job = await getJob(repo, null, t.id, posting.id);
    expect(job.scored).toBe(true);
    expect(job.card.score).toBeGreaterThan(0);
    expect(job.application?.status).toBe("ready");
    expect(job.apply.willFill).toEqual(expect.arrayContaining(["email"]));
    expect(job.apply.missing).not.toContain("email");
  });

  it("a missing posting is a clear not-found, not a crash", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await expect(getJob(repo, null, t.id, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(JobNotFoundError);
  });
});

describe("background sync", () => {
  it("someone who JOINS a running sync still gets their follow-up (ranking) — and it's 'syncing' until then", async () => {
    const repo = new InMemoryRepository();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const first = startCorpusSync(repo, undefined, async () => {
      await gate;
      order.push("sync");
    });
    expect(corpusSyncing()).toBe(true);
    // a second caller (e.g. onboarding finished mid-sync) joins with its own follow-up
    const joined = startCorpusSync(repo, async () => {
      expect(corpusSyncing()).toBe(true);
      order.push("rank");
    });
    expect(joined).toBe(first);
    release();
    await first;
    expect(order).toEqual(["sync", "rank"]);
    expect(corpusSyncing()).toBe(false);
  });
});

describe("cards before onboarding", () => {
  it("carry no profile-relative judgement (no experience fit against a blank 0-years profile)", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    const posting = await seedPosting(repo, "Staff Engineer", "Staff role. 10+ years of experience.");
    const [card] = await toCards(repo, t.id, [{ posting, match: null }]);
    expect(card!.experience.min).toBe(10);
    expect(card!.experience.fit).toBeNull();
    const feed = await getFeed(repo, t.id, { bootstrap: false });
    expect(feed.cards[0]!.experience.fit).toBeNull();
  });
});
