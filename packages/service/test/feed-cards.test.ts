import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { normCompany, normalizePosting, type RawPosting } from "@jobflow/core";
import { DEFAULT_TENANT, toNewPosting } from "@jobflow/pipeline";
import { getFeed, loadSampleProfile, rankTenant, seedDemoCorpus } from "../src/index.js";

/**
 * Feed cards as a job seeker reads them (2026-11 feed review). Fictional companies and
 * postings only. The same card is what the web, `jobflow feed` and the MCP tools render.
 */

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });

async function seed(repo: InMemoryRepository, company: string, title: string, location: string, jd: string, i: number) {
  const slug = company.toLowerCase().replace(/[^a-z]+/g, "");
  const co = await repo.upsertCompany({ name: company, nameNorm: normCompany(company), atsType: "greenhouse", atsSlug: slug });
  const raw: RawPosting = {
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: `job-${i}`, companyName: co.name,
    companySlug: slug, title, jdText: jd, jdHtml: null, locationRaw: location, applyUrl: `https://example.com/${slug}/${i}`,
    salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
  };
  return repo.upsertPosting(await toNewPosting(normalizePosting(raw), co.id, co.name, embed));
}

const JD = "Backend role: Java, Kafka, PostgreSQL, distributed systems, microservices. 2-5 years of experience. ".repeat(4);

async function feedFor(rows: Array<[string, string, string, string?]>) {
  const repo = new InMemoryRepository();
  const t = await repo.createTenant({ name: "t" });
  for (const [i, [company, title, loc, jd]] of rows.entries()) await seed(repo, company, title, loc, jd ?? JD, i);
  await loadSampleProfile(repo, t.id);
  await rankTenant(repo, t.id);
  return getFeed(repo, t.id, { bootstrap: false });
}

describe("feed cards (one plain-language card for every surface)", () => {
  it("every card has a location line, remote ones say where from, and real country names", async () => {
    const feed = await feedFor([
      ["Example Remote Co", "Backend Engineer", "Remote (Worldwide)"],
      ["Example APAC Co", "Backend Engineer", "Remote (APAC)"],
      ["Example Canada Co", "Backend Engineer", "Remote - Canada"],
      ["Example Munich Co", "Backend Engineer", "München, Deutschland (Hybrid)"],
      ["Example Multi Co", "Backend Engineer", "Hybrid - Bengaluru, India; Singapore"],
    ]);
    const label = (co: string) => feed.cards.find((c) => c.company === co)!.location;
    for (const c of feed.cards) expect(c.location.label).not.toBe("");
    expect(label("Example Remote Co").label).toBe("Remote · worldwide");
    expect(label("Example APAC Co").label).toBe("Remote · APAC");
    expect(label("Example Canada Co").label).toBe("Remote · Canada only");
    const munich = label("Example Munich Co");
    expect(munich.label).toMatch(/^Hybrid · (München|Munich), Germany$/);
    expect(munich.country).toBe("Germany");
    const multi = label("Example Multi Co");
    expect(multi.label).toBe("Hybrid · Bengaluru, India + Singapore");
    expect(multi.places).toEqual(["Bengaluru, India", "Singapore"]);
  });

  it("'workable' is about the user's own home/markets (region-neutral), not India", async () => {
    const feed = await feedFor([
      ["Example Pune Co", "Backend Engineer", "Pune, India"],
      ["Example Austin Co", "Backend Engineer", "Austin, TX"],
    ]);
    // the fictional sample persona lives in India
    expect(feed.cards.find((c) => c.company === "Example Pune Co")!.workable).toBe(true);
    expect(feed.cards.find((c) => c.company === "Example Austin Co")!.workable).toBe(false);
    expect(feed.cards[0]).not.toHaveProperty("indiaWorkable");
  });

  it("a staffing-agency post says so on the card and in its flags", async () => {
    const feed = await feedFor([
      ["TalentBridge Consultancy", "Backend Engineer", "Bengaluru, India", "We are hiring on behalf of our client, a growing fintech. " + JD],
      ["Example Direct Co", "Backend Engineer", "Bengaluru, India"],
    ]);
    const agency = feed.cards.find((c) => c.company === "TalentBridge Consultancy")!;
    expect(agency.agency).toBe(true);
    expect(agency.redFlags.join(" ")).toMatch(/staffing agency, not the employer/);
    expect(feed.cards.find((c) => c.company === "Example Direct Co")!.agency).toBe(false);
  });

  it("the spread never sinks a company's strong 4th/5th role under much weaker cards", async () => {
    const rows: Array<[string, string, string, string?]> = [];
    for (let i = 0; i < 5; i++) rows.push(["Example Pay", `Backend Engineer ${["Ledger", "Payments", "Risk", "Billing", "Payouts"][i]}`, "Bengaluru, India"]);
    rows.push(["Example Other", "Backend Engineer", "Bengaluru, India"]);
    // a much weaker card: not an engineering role, far more years asked
    rows.push(["Example Weak Co", "Account Executive", "Bengaluru, India", "Sell our product to enterprise buyers. 10+ years in enterprise sales."]);
    const feed = await feedFor(rows);
    const weak = feed.cards.findIndex((c) => c.company === "Example Weak Co");
    const pay = feed.cards.map((c, i) => (c.company === "Example Pay" ? i : -1)).filter((i) => i >= 0);
    expect(pay).toHaveLength(5);
    const weakScore = feed.cards[weak]!.score;
    for (const i of pay) if (feed.cards[i]!.score - weakScore > 12) expect(i).toBeLessThan(weak);
  });
});

describe("the same role posted per country is one card (taxonomy pass)", () => {
  const SRE_JD = "Example Grafanaish runs observability for thousands of teams. Java, Kafka, PostgreSQL, distributed systems, microservices; on-call for ingestion. 2-5 years of experience. ".repeat(4);
  async function siblingFeed(groupSiblings?: boolean, also?: (feed: Awaited<ReturnType<typeof getFeed>>) => Promise<void>) {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    const rows: Array<[string, string, string, string]> = [
      ["Example Grafanaish", "Backend Engineer, Ingestion", "Bengaluru, India", SRE_JD],
      ["Example Grafanaish", "Backend Engineer, Ingestion", "London, United Kingdom", SRE_JD],
      ["Example Grafanaish", "Backend Engineer, Ingestion", "Berlin, Germany", SRE_JD],
      ["Example Grafanaish", "Backend Engineer, Ingestion", "Austin, TX", SRE_JD],
      ["Example Other", "Backend Engineer", "Bengaluru, India", JD],
    ];
    for (const [i, [company, title, loc, jd]] of rows.entries()) await seed(repo, company, title, loc, jd, i);
    await loadSampleProfile(repo, t.id);
    await rankTenant(repo, t.id);
    const feed = await getFeed(repo, t.id, { bootstrap: false, groupSiblings });
    if (also) await also(await getFeed(repo, t.id, { bootstrap: false, groupSiblings: !groupSiblings }));
    return feed;
  }

  it("shows the sibling that fits the user best, says where else it's posted, and counts the fold", async () => {
    const feed = await siblingFeed();
    const cards = feed.cards.filter((c) => c.company === "Example Grafanaish");
    expect(cards).toHaveLength(1);
    // the fictional sample persona lives in India: the Bengaluru req is the best fit
    expect(cards[0]!.location.label).toMatch(/Bengaluru/);
    expect(cards[0]!.siblings.map((s) => s.place).sort()).toEqual(["Germany", "UK", "US"]);
    expect(cards[0]!.alsoPosted).toMatch(/^Also posted for /);
    expect(feed.stats.siblingsFolded).toBe(3);
    expect(feed.cards.find((c) => c.company === "Example Other")!.siblings).toEqual([]);
  });

  it("scores are untouched and grouping can be switched off (every req is its own card)", async () => {
    let on!: Awaited<ReturnType<typeof getFeed>>;
    const off = await siblingFeed(false, async (f) => void (on = f));
    const all = off.cards.filter((c) => c.company === "Example Grafanaish");
    expect(all).toHaveLength(4);
    const lead = on.cards.find((c) => c.company === "Example Grafanaish")!;
    expect(lead.score).toBe(Math.max(...all.map((c) => c.score)));
    for (const s of lead.siblings) expect(s.score).toBe(all.find((c) => c.id === s.id)!.score);
  });
});

describe("the offline demo corpus reads cleanly", () => {
  it("no empty location line, no doubled place, no internal ids in the notes", async () => {
    const repo = new InMemoryRepository();
    await seedDemoCorpus(repo, DEFAULT_TENANT);
    await rankTenant(repo, DEFAULT_TENANT);
    const feed = await getFeed(repo, DEFAULT_TENANT, { bootstrap: false });
    expect(feed.cards.length).toBeGreaterThan(5);
    for (const c of feed.cards) {
      expect(c.location.label).not.toBe("");
      expect(c.location.label).not.toMatch(/(\b[\w ]+), \1\b|Europe/);
      expect(`${c.stackNote ?? ""} ${c.levelNote ?? ""} ${c.redFlags.join(" ")}`).not.toMatch(/_|direct match|ramp\)|JD requires/);
    }
  });
});
