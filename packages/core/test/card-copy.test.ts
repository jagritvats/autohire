import { describe, expect, it } from "vitest";
import {
  companyDisplayName,
  describeLocation,
  diversifyByCompany,
  moreBelow,
  parseLocation,
  placeCountries,
  primaryLanguage,
  scorePosting,
  stackAdjacency,
  staleDamp,
  workableFor,
  type Posting,
  type Profile,
} from "../src/index.js";

/**
 * Card copy and feed-order fixes from the 2026-11 feed review (four fictional personas,
 * live corpora): every fixture here is invented. What a skeptical job seeker saw: empty or
 * doubled location labels ("Canada, Canada", "Poland, Europe"), "Primary language java"
 * on a Go/Python role, a 300-day-old req among this week's, data and ML roles filling a
 * frontend developer's top 50, and a company's 4th role at 87 sunk below a 42.
 */

const now = new Date();

function posting(over: Partial<Posting> = {}): Posting {
  return {
    id: "p1",
    companyId: "c1",
    companyName: "Example Co",
    source: "greenhouse",
    tier: "tier1",
    atsType: "greenhouse",
    atsJobId: "1",
    title: "Software Engineer",
    titleNorm: "software-engineer",
    roleArchetype: "backend",
    levelBand: null,
    jdText: "We build things. ".repeat(40),
    jdSkills: [],
    requirements: [],
    location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
    salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: "https://example.com/apply",
    postedAt: now,
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    canonicalId: null,
    dedupKey: "example|software-engineer|remote",
    ...over,
  } as Posting;
}

function profile(over: Partial<Profile["prefs"]> = {}, top: Partial<Profile> = {}): Profile {
  return {
    id: "u1",
    tenantId: "t1",
    masterResume: "x",
    resumeLatex: "",
    aboutText: "",
    yoe: 4,
    levelBand: "mid",
    prefs: {
      salaryFloor: 0,
      currency: "USD",
      homeCountry: "US",
      markets: ["US"],
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [{ label: "remote", weight: 1 }],
      stackMustHaves: [],
      stackProfile: ["go", "python", "kafka", "postgres"],
      remoteGeoOk: ["worldwide"],
      relocate: false,
      targetArchetypes: ["backend"],
      ...over,
    },
    onboardedAt: now,
    ...top,
  } as Profile;
}

describe("location line (one wording for web, CLI and MCP)", () => {
  const label = (raw: string) => describeLocation(parseLocation(raw, "")).label;

  it("a remote role always says where it can be done from", () => {
    expect(label("Remote (Worldwide)")).toBe("Remote · worldwide");
    expect(label("Remote (APAC)")).toBe("Remote · APAC");
    expect(label("Remote - Canada")).toBe("Remote · Canada only");
    expect(describeLocation({ mode: "remote", city: null, country: null, remoteGeo: "unknown" }).label).toBe("Remote · region not stated");
  });

  it("names the real country, never the legacy region 'Europe' when the country is known", () => {
    const munich = describeLocation({ mode: "hybrid", city: "München", country: "Europe", countries: ["DE"], remoteGeo: "unknown" });
    expect(munich.label).toBe("Hybrid · München, Germany");
    expect(munich.country).toBe("Germany");
    // a row from before `countries` existed keeps what it has
    expect(describeLocation({ mode: "onsite", city: "Berlin", country: "Europe", remoteGeo: "unknown" }).label).toBe("Onsite · Berlin, Europe");
  });

  it("never doubles a place ('Canada, Canada', 'India, India') and fixes shouting / lower-case cities", () => {
    expect(describeLocation({ mode: "onsite", city: "India", country: "India", remoteGeo: "unknown" }).label).toBe("Onsite · India");
    expect(describeLocation({ mode: "onsite", city: "Singapore", country: "Singapore", countries: ["SG"], remoteGeo: "unknown" }).label).toBe("Onsite · Singapore");
    expect(describeLocation({ mode: "onsite", city: "GURGAON", country: "India", remoteGeo: "unknown" }).label).toBe("Onsite · Gurgaon, India");
    expect(describeLocation({ mode: "onsite", city: "bangalore", country: "India", remoteGeo: "unknown" }).label).toBe("Onsite · Bangalore, India");
    expect(describeLocation({ mode: "onsite", city: "NYC", country: "United States", countries: ["US"], remoteGeo: "unknown" }).label).toBe("Onsite · NYC, US");
  });

  it("shows the other places: one by name, more as a count — every one in `places`", () => {
    const two = describeLocation({ mode: "hybrid", city: "Bengaluru", country: "India", countries: ["IN", "SG"], remoteGeo: "unknown" });
    expect(two.label).toBe("Hybrid · Bengaluru, India + Singapore");
    expect(two.places).toEqual(["Bengaluru, India", "Singapore"]);
    const many = describeLocation({ mode: "hybrid", city: "Austin", country: "United States", countries: ["US", "GB", "DE"], remoteGeo: "unknown" });
    expect(many.label).toBe("Hybrid · Austin, US + 2 more");
    expect(many.places).toEqual(["Austin, US", "UK", "Germany"]);
  });

  it("nothing known reads as such, not as an empty string", () => {
    expect(describeLocation({ mode: "unknown", city: null, country: null, remoteGeo: "unknown" }).label).toBe("Location not stated");
  });

  it("flags name the real country too", () => {
    expect(placeCountries({ country: "Europe", countries: ["DE"] })).toBe("Germany");
    expect(placeCountries({ country: "India", countries: ["IN", "SG"] })).toBe("India / Singapore");
  });
});

describe("workable for you (region-neutral, replaces the India-only flag)", () => {
  const de = { currency: "EUR", locationWeights: [], homeCountry: "DE", markets: ["DE", "NL"], remoteGeoOk: [] as Profile["prefs"]["remoteGeoOk"] };
  it("an office in home or a market, or remote open to where you live", () => {
    expect(workableFor({ mode: "hybrid", city: "München", country: "Europe", countries: ["DE"], timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 }, de)).toBe(true);
    expect(workableFor({ mode: "onsite", city: "Austin", country: "United States", countries: ["US"], timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 }, de)).toBe(false);
    expect(workableFor({ mode: "remote", city: null, country: null, timezone: null, remoteGeo: "eu_only", sponsorship: null, confidence: 0.9 }, de)).toBe(true);
    expect(workableFor({ mode: "remote", city: null, country: null, timezone: null, remoteGeo: "us_only", sponsorship: null, confidence: 0.9 }, de)).toBe(false);
  });
  it("can't tell → null, never a guess", () => {
    expect(workableFor({ mode: "onsite", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.3 }, de)).toBeNull();
    const nowhere = { currency: "USD", locationWeights: [], homeCountry: "", markets: [], remoteGeoOk: [] as Profile["prefs"]["remoteGeoOk"] };
    expect(workableFor({ mode: "onsite", city: "Pune", country: "India", timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 }, nowhere)).toBeNull();
  });
});

describe("company name on a card", () => {
  it("drops legal-form noise and spells out a board slug; leaves lower-case brands alone", () => {
    expect(companyDisplayName("Gebbs Healthcare Solutions Pvt. Ltd.")).toBe("Gebbs Healthcare Solutions");
    expect(companyDisplayName("NeoGenCode Technologies Pvt Ltd")).toBe("NeoGenCode Technologies");
    expect(companyDisplayName("Fluence International, Inc.")).toBe("Fluence International");
    expect(companyDisplayName("Example Media AG")).toBe("Example Media");
    expect(companyDisplayName("Example Corp")).toBe("Example Corp"); // part of the name people know
    expect(companyDisplayName("acme-pay")).toBe("Acme Pay");
    expect(companyDisplayName("examplebrand")).toBe("examplebrand");
    expect(companyDisplayName("Inc.")).toBe("Inc.");
  });
});

describe("main language (jdSkills come in dictionary order, not the posting's)", () => {
  it("the title decides when it names one", () => {
    expect(primaryLanguage(["java", "kotlin", "typescript"], { title: "Software Engineer Fullstack Kotlin / React", jdText: "Java and Kotlin, TypeScript" })).toBe("kotlin");
  });
  it("else the most-mentioned language in the JD", () => {
    const jd = "You'll write Go services. Our stack: Go, Python for tooling, Go everywhere. Java experience is a plus.";
    expect(primaryLanguage(["java", "go", "python"], { title: "Backend Engineer", jdText: jd })).toBe("go");
  });
  it("the card note names it, in plain words, with what else the posting asks", () => {
    const r = stackAdjacency(["go", "python", "kafka"], ["java", "go", "python", "kafka", "kubernetes"], {
      title: "Software Engineer, Streaming Platform",
      jdText: "Build streaming in Go and Python on Kafka. Some services are Java. Go, Python, Kubernetes.",
    });
    expect(r.jdPrimaryLanguage).toBe("go");
    expect(r.note).toBe("Main language Go — you have it. You have Kafka; new to you: Kubernetes.");
    expect(r.note).not.toMatch(/ramp|direct match|_/);
  });
  it("a declared skill the dictionary doesn't know counts when the JD names it", () => {
    const analyst = ["sql", "tableau", "excel", "python", "r"];
    const jd = "Data Analyst: SQL every day, Tableau dashboards, Excel models; Python or R, a plus.";
    const withText = stackAdjacency(analyst, ["python"], { title: "Data Analyst", jdText: jd });
    const without = stackAdjacency(analyst, ["python"]);
    expect(withText.score).toBeGreaterThan(without.score);
    expect(withText.note).toMatch(/You have SQL, tableau, excel and R/);
    // a one-letter skill only as a standalone capital: "r" is not found in "your role"
    expect(stackAdjacency(["r"], [], { jdText: "your role as a reviewer" }).note).not.toMatch(/You have r/);
  });
});

describe("ranking a skeptical user would trust", () => {
  it("a months-old req ranks below the same role posted this week (soft — never hidden)", () => {
    const fresh = scorePosting(posting(), profile());
    const old = scorePosting(posting({ postedAt: new Date(Date.now() - 300 * 86_400_000) }), profile());
    expect(old.score).toBeLessThan(fresh.score - 10);
    expect(old.rulePass).toBe(true);
    expect(old.flags.redFlags.join(" ")).toMatch(/Open ~300 days/);
    expect([30, 90, 150, 400].map(staleDamp)).toEqual([1, 0.95, 0.9, 0.85]);
  });

  it("archetype fit is directional: a frontend dev's data/ML/SRE roles sit well below frontend ones", () => {
    const fe = profile({ targetArchetypes: ["frontend", "fullstack"], stackProfile: ["react", "typescript"] });
    const s = (a: Posting["roleArchetype"]) => scorePosting(posting({ roleArchetype: a }), fe).breakdown.archetype;
    expect(s("frontend")).toBe(1);
    expect(s("fullstack")).toBe(1);
    expect(s("backend")).toBeLessThanOrEqual(0.6); // was a flat 0.65 for every non-target engineering role
    expect(s("backend")).toBeGreaterThan(s("data_ml"));
    expect(s("data_ml")).toBeLessThanOrEqual(0.35);
    expect(s("sre")).toBeLessThanOrEqual(0.35);
    // frontend alone: data/infra roles are far
    const feOnly = profile({ targetArchetypes: ["frontend"], stackProfile: ["react"] });
    expect(scorePosting(posting({ roleArchetype: "data_ml" }), feOnly).breakdown.archetype).toBeLessThanOrEqual(0.2);
    // and the backend view is unchanged in spirit: platform near, frontend far
    const be = profile();
    const b = (a: Posting["roleArchetype"]) => scorePosting(posting({ roleArchetype: a }), be).breakdown.archetype;
    expect(b("platform")).toBeGreaterThan(b("frontend"));
  });

  it("a data-analyst title the normalizer filed as 'other' is on target for a data persona", () => {
    const da = profile({ targetArchetypes: ["data_ml"], stackProfile: ["sql", "python"] }, { yoe: 0, levelBand: "junior" });
    const analyst = scorePosting(posting({ title: "Data Analyst", roleArchetype: "other" }), da);
    expect(analyst.breakdown.archetype).toBe(1);
    expect(analyst.flags.redFlags.join(" ")).not.toMatch(/Not an engineering role/);
    for (const title of ["Business Intelligence Analyst", "Marketing & GTM Data Analyst", "Analytics Engineer", "Data Scientist II, Marketing"]) {
      expect(scorePosting(posting({ title, roleArchetype: "other" }), da).breakdown.archetype).toBe(1);
    }
    // facilities work with "data" in the title is not a data role
    expect(scorePosting(posting({ title: "Data Center Operations Engineer", roleArchetype: "other" }), da).breakdown.archetype).toBeLessThan(0.1);
    const sales = scorePosting(posting({ title: "Account Executive", roleArchetype: "other" }), da);
    expect(sales.breakdown.archetype).toBeLessThan(0.1);
    expect(sales.flags.redFlags.join(" ")).toMatch(/Not an engineering role/);
  });

  it("an agency post always says so, however many other flags it carries", () => {
    const busy = posting({
      companyName: "TalentBridge Consultancy",
      jdText: "We are hiring on behalf of our client, a fintech. " + "Details. ".repeat(60),
      postedAt: new Date(Date.now() - 200 * 86_400_000),
      lastSeen: new Date(Date.now() - 20 * 86_400_000),
      location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.3 },
      requirements: [
        { skill: "rust", strength: "must_have" },
        { skill: "scala", strength: "must_have" },
      ],
      levelBand: "staff",
    });
    const r = scorePosting(busy, profile());
    expect(r.flags.redFlags.length).toBeGreaterThanOrEqual(5);
    expect(r.flags.redFlags.join(" ")).toMatch(/staffing agency, not the employer/);
  });

  it("an unpaid / volunteer role is flagged and sinks (soft), and 'Talent Finders' reads as an agency", () => {
    const paid = scorePosting(posting({ title: "Data Analyst" }), profile());
    const vol = scorePosting(posting({ title: "Data Analyst, Volunteer, Remote" }), profile());
    expect(vol.flags.redFlags[0]).toBe("Unpaid / volunteer role");
    expect(vol.score).toBeLessThan(paid.score - 15);
    expect(vol.rulePass).toBe(true);
    const a5 = scorePosting(posting({ companyName: "Example Talent Finders" }), profile());
    expect(a5.flags.redFlags.join(" ")).toMatch(/staffing agency/);
  });

  it("a freelance marketplace is an intermediary too, and says so", () => {
    const r = scorePosting(posting({ companyName: "Toptal", title: "Senior Fullstack Engineer" }), profile());
    expect(r.flags.redFlags.join(" ")).toMatch(/freelance marketplace, not the employer/);
    expect(r.breakdown.sourceTrust).toBeLessThan(scorePosting(posting(), profile()).breakdown.sourceTrust);
  });

  it("must-haves you lack read plainly, once, and skip what you'd pick up from a close language", () => {
    const r = scorePosting(
      // Kafka covers distributed systems and Go is close to Java: only Rust and Scala are real gaps
      posting({ requirements: ["distributed_systems", "rust", "java", "scala"].map((skill) => ({ skill, strength: "must_have" as const })) }),
      profile(),
    );
    const flags = r.flags.redFlags.filter((f) => f.startsWith("Asks for"));
    expect(flags).toEqual(["Asks for Rust, Scala — not in your skills"]);
  });
});

describe("company spread: never sink a strong card under much weaker ones", () => {
  const card = (id: string, company: string, score: number) => ({ id, company, score });
  it("a company's 4th/5th role at 87/86 lands above a 42, not at the very end", () => {
    const list = [
      card("a1", "Acme Pay", 92), card("a2", "Acme Pay", 90), card("a3", "Acme Pay", 89), card("a4", "Acme Pay", 87), card("a5", "Acme Pay", 86),
      card("b", "Globex", 85), card("c", "Initech", 84), card("d", "Hooli", 80), card("e", "Umbrella", 70),
      card("f", "Stark", 60), card("g", "Wayne", 55), card("h", "Soylent", 42),
    ];
    const out = diversifyByCompany(list, (c) => c.company, { scoreOf: (c) => c.score });
    const pos = (id: string) => out.findIndex((c) => c.id === id);
    expect(pos("a4")).toBeLessThan(pos("h"));
    expect(pos("a5")).toBeLessThan(pos("h"));
    // near-equals still trade places: the 85 and 84 come before the 4th Acme role
    expect(pos("b")).toBeLessThan(pos("a4"));
    expect(pos("c")).toBeLessThan(pos("a4"));
    // a deferred card never sits below one more than the gap (12) under it
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) expect(out[j]!.score - out[i]!.score).toBeLessThanOrEqual(12);
    // nothing dropped, no score changed, each company keeps its own order
    expect(out).toHaveLength(list.length);
    expect(out.filter((c) => c.company === "Acme Pay").map((c) => c.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("'+N more at X' marks a company's last card on the page with what follows", () => {
    const ordered = [card("a1", "Acme", 90), card("b", "B", 89), card("a2", "Acme", 88), card("c", "C", 80), card("a3", "Acme", 79), card("a4", "Acme", 70)];
    const more = moreBelow(ordered, (c) => c.company, 4);
    expect([...more.entries()]).toEqual([[2, 2]]);
    expect(moreBelow(ordered, (c) => c.company, 6).size).toBe(0);
  });
});
