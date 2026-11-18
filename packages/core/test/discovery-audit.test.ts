import { describe, it, expect } from "vitest";
import {
  dedup,
  dedupTitleKey,
  extractSkills,
  normalizePosting,
  parseExperience,
  parseLocation,
  parsedCountryMatches,
  parseStatedSalary,
  parseTitle,
  scorePosting,
  type Posting,
  type Profile,
  type RawPosting,
} from "../src/index.js";

/**
 * Regression fixtures from the 2026-11 discovery audit (docs/internal/DISCOVERY_AUDIT.md):
 * each case is a minimised, fictionalised copy of a real posting the pipeline got wrong on a
 * live corpus. Company names are invented.
 */

function raw(over: Partial<RawPosting>): RawPosting {
  return {
    source: "greenhouse",
    tier: "tier1",
    atsType: "greenhouse",
    atsJobId: "1",
    companyName: "Acme Pay",
    companySlug: "acmepay",
    title: "Backend Engineer",
    jdText: "Build services in Java and Postgres.",
    jdHtml: null,
    locationRaw: "Bengaluru, India",
    applyUrl: null,
    salaryRaw: null,
    postedAt: null,
    fetchedAt: new Date(),
    raw: {},
    ...over,
  } as RawPosting;
}

let seq = 0;
function posting(r: Partial<RawPosting>, over: Partial<Posting> = {}): Posting {
  const n = normalizePosting(raw({ atsJobId: String(++seq), ...r }));
  const now = new Date();
  return {
    ...n,
    id: `p${seq}`,
    companyId: "c",
    salaryEstimate: null,
    jdEmbedding: null,
    embedKey: null,
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    status: "active",
    invalidReason: null,
    invalidatedAt: null,
    canonicalId: null,
    ...over,
  } as Posting;
}

function canonicalCount(ps: Posting[]): number {
  return dedup(ps).canonicalIds.length;
}

describe("dedup keeps distinct roles apart (43% of a live corpus was hidden)", () => {
  it("different teams of one company in one place are different roles", () => {
    const loc = { locationRaw: "Remote - USA" };
    const ps = [
      posting({ ...loc, title: "Senior Software Engineer, Backend (Consumer)" }),
      posting({ ...loc, title: "Senior Software Engineer, Backend (Retail)" }),
      posting({ ...loc, title: "Staff Software Engineer, Compute Platform" }),
      // "Developer" in a PM title used to map the whole title to "software-engineer"
      posting({ ...loc, title: "Group Product Manager, Developer Infrastructure" }),
    ];
    expect(canonicalCount(ps)).toBe(4);
  });

  it("boilerplate-identical JD embeddings on one board never merge two reqs", () => {
    const same = [0.5, 0.5, 0.5, 0.5];
    const ps = [
      posting({ title: "Enterprise Account Executive", locationRaw: "Tokyo, Japan" }, { jdEmbedding: same }),
      posting({ title: "Solutions Consultant", locationRaw: "Tokyo, Japan" }, { jdEmbedding: same }),
      posting({ title: "Sr Software Engineer - Android", locationRaw: "Austin, TX" }, { jdEmbedding: same }),
      posting({ title: "Staff Software Engineer iOS", locationRaw: "Austin, TX" }, { jdEmbedding: same }),
    ];
    expect(canonicalCount(ps)).toBe(4);
  });

  it("keeps the level: a senior and a mid role are two cards", () => {
    expect(canonicalCount([posting({ title: "Senior Product Manager" }), posting({ title: "Product Manager II" })])).toBe(2);
  });

  it("still merges the same role re-listed by an aggregator, and the ATS copy wins", () => {
    const board = posting({ title: "Senior Site Reliability Engineer", locationRaw: "Bangalore, India" });
    const agg = posting({
      source: "cutshort",
      tier: "tier2",
      atsType: "unknown",
      title: "Sr. Site Reliability Engineer",
      locationRaw: "Bengaluru (Bangalore), India",
    });
    const r = dedup([agg, board]);
    expect(r.canonicalIds).toEqual([board.id]);
    expect(r.canonicalByPostingId.get(agg.id)).toBe(board.id);
  });

  it("merges developer/engineer phrasings across sources, not across levels", () => {
    const board = posting({ title: "Senior Backend Engineer" });
    const agg = posting({ source: "hirist", tier: "tier2", atsType: "unknown", title: "Senior Backend Developer" });
    const junior = posting({ source: "instahyre", tier: "tier2", atsType: "unknown", title: "Backend Developer" });
    const r = dedup([board, agg, junior]);
    expect(r.canonicalByPostingId.get(agg.id)).toBe(board.id);
    expect(r.canonicalByPostingId.get(junior.id)).toBe(junior.id);
  });

  it("the title key collapses phrasing noise but not the team", () => {
    expect(dedupTitleKey("Sr. SDE II")).toBe(dedupTitleKey("Senior Software Development Engineer 2"));
    expect(dedupTitleKey("Backend Engineer (Remote, US)")).toBe(dedupTitleKey("Backend Engineer"));
    expect(dedupTitleKey("Software Engineer, Go + Networking")).toBe(dedupTitleKey("Software Engineer - Networking + Go"));
    expect(dedupTitleKey("Software Dev Engineer II - AMZ10587293")).toBe(dedupTitleKey("Software Development Engineer II"));
    expect(dedupTitleKey("Software Engineer (Backend)")).not.toBe(dedupTitleKey("Software Engineer (Frontend)"));
    expect(dedupTitleKey("AI Success Manager (US East Customer Hours)")).not.toBe(dedupTitleKey("AI Success Manager (US West Customer Hours)"));
  });
});

describe("skills match whole words (90% of Scala / 97% of Rust tags were false)", () => {
  it("does not read English words as skills", () => {
    const jd =
      "Design scalable, highly available systems. Build trust with customers and leverage storage " +
      "best practices; ship within weeks. Build consensus with stakeholders, draft proposals and " +
      "react appropriately to incidents. The cluster can grow past a single node.";
    const s = extractSkills(jd);
    for (const k of ["scala", "rust", "ml", "kubernetes", "distributed_systems", "react", "javascript"]) expect(s).not.toContain(k);
  });

  it("still finds the real ones", () => {
    const s = extractSkills(
      "Scala and Akka; Rust services; LLMs with RAG; EKS and Helm; React, Redux; Dockerized microservice " +
        "architecture; Node.js backend; distributed systems.",
    );
    for (const k of ["scala", "rust", "ml", "kubernetes", "react", "docker", "microservices", "javascript", "distributed_systems"]) {
      expect(s).toContain(k);
    }
    // the capitalised library name needs no cue; the verb never counts
    expect(extractSkills("React and CSS. Remote worldwide.")).toContain("react");
    expect(extractSkills("React quickly to customer escalations.")).not.toContain("react");
  });
});

describe("experience ignores the employer's age (~200 postings read as 25–40 yrs asked)", () => {
  it.each([
    "We've been innovating fearlessly for 40 years to create solutions that power how humans connect.",
    "We have a 25+ year track record of innovation and a reputation for excellence.",
    "Our company has been revolutionizing commerce globally for more than 25 years.",
    "Building upon more than 30 years of computational software expertise.",
    "After 30 years of painfully slow progress, the field moved.",
  ])("no requirement in: %s", (jd) => {
    expect(parseExperience(jd)).toEqual({ min: null, max: null });
  });

  it("keeps a real senior requirement", () => {
    expect(parseExperience("What we look for: 15+ years of industry experience building large systems.").min).toBe(15);
  });
});

describe("salary: an INR band too small to be a year's pay is never 'high'", () => {
  const loc = parseLocation("Bengaluru, India");
  it("'₹2L – ₹2.5L' on a senior role (likely monthly) can't drive the hard floor", () => {
    expect(parseStatedSalary("₹2L – ₹2.5L", "", loc)).toMatchObject({ max: 250_000, confidence: "medium_high" });
    expect(parseStatedSalary("₹1.2L – ₹1.6L • 0.3% – 0.5%", "", loc).confidence).toBe("medium_high");
  });
  it("a plausible annual band, or one with a stated period, stays high", () => {
    expect(parseStatedSalary("₹22L – ₹27L • No equity", "", loc).confidence).toBe("high");
    expect(parseStatedSalary("₹50,000 - ₹80,000 per month", "", loc)).toMatchObject({ max: 960_000, confidence: "high" });
  });
});

describe("titles: a team / domain suffix is not the role", () => {
  it.each([
    ["Software Engineer, Financial Business Insights", "backend"],
    ["Senior Software Engineer - Marketplace", "backend"],
    ["Backend Software Engineer - Codex for Finance", "backend"],
    ["Software Development Engineer II, Payments Platform", "infra_devops"],
    ["Software Dev Engineer II, Last Mile", "backend"],
    ["Web Developer", "fullstack"],
  ])("%s → %s", (title, arch) => {
    expect(parseTitle(title).roleArchetype).toBe(arch);
  });

  it.each(["Sales Engineer, Platform", "Product Manager, Backend Platform", "Solutions Architect - Fintech", "Software Development Manager"])(
    "%s stays non-engineering",
    (title) => {
      expect(parseTitle(title).roleArchetype).toBe("other");
    },
  );
});

describe("location: places the parser didn't know, and boilerplate 'worldwide'", () => {
  it("a US-state remote role is US-only, not worldwide from 'customers worldwide'", () => {
    const l = parseLocation("Remote - California", "Trusted by customers worldwide. This role is remote.");
    expect(l).toMatchObject({ mode: "remote", country: "United States", remoteGeo: "us_only" });
    expect(l.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("names countries outside IN/US/CA/Europe so onsite abroad is known", () => {
    expect(parseLocation("Singapore")).toMatchObject({ country: "Singapore", confidence: 0.85 });
    expect(parseLocation("JP-Tokyo")).toMatchObject({ city: "Tokyo", country: "Japan" });
    expect(parseLocation("Sao Paulo, Brazil").country).toBe("Brazil");
    expect(parseLocation("Bellevue, Washington").country).toBe("United States");
    expect(parseLocation("Belgrade, Serbia").country).toBe("Europe");
    expect(parsedCountryMatches("Japan", "JP")).toBe(true);
    expect(parsedCountryMatches("Japan", "IN")).toBe(false);
    expect(parsedCountryMatches("Japan", "DE")).toBe(false);
  });

  it("reads Ashby's US-CA-Dublin as California, not Ireland", () => {
    const l = parseLocation("Remote US-WA-Bellevue; US-CA-Dublin", "");
    expect(l).toMatchObject({ country: "United States", remoteGeo: "us_only" });
  });

  it("'Remote - Canada' is one country, not the US-or-Americas bucket; 'US or Canada' still is", () => {
    expect(parseLocation("Remote - Canada", "")).toMatchObject({ country: "Canada", remoteGeo: "unknown", confidence: 0.8 });
    expect(parseLocation("Remote - US; Remote - Canada", "").remoteGeo).toBe("us_only");
    expect(parseLocation("Remote - North America", "").remoteGeo).toBe("us_only");
  });

  it("'Remote Singapore' is remote within Singapore, not US-only from a stray 'US' in the JD", () => {
    const l = parseLocation("Remote Singapore", "Work with teams in the US and Europe.");
    expect(l).toMatchObject({ mode: "remote", country: "Singapore", remoteGeo: "unknown" });
    expect(l.confidence).toBe(0.8);
  });
});

describe("ranking: abroad and country-bound remote are soft signals with honest flags", () => {
  const base = {
    id: "u",
    tenantId: "t",
    masterResume: "",
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 4,
    levelBand: "mid",
  };
  function profile(home: string, markets: string[]): Profile {
    return {
      ...base,
      prefs: {
        stackProfile: ["java", "postgres"],
        targetArchetypes: ["backend"],
        salaryFloor: 0,
        currency: home === "IN" ? "INR" : "USD",
        locationWeights: [{ label: "remote", weight: 1 }],
        remoteGeoOk: ["worldwide"],
        relocate: false,
        homeCountry: home,
        markets,
      },
    } as unknown as Profile;
  }

  it("onsite Tokyo for a user in India is discounted and flagged (was neutral: no country)", () => {
    const r = scorePosting(posting({ locationRaw: "Tokyo, Japan" }), profile("IN", ["IN"]));
    expect(r.rulePass).toBe(true);
    expect(r.flags.redFlags.join(" ")).toMatch(/Onsite Japan/);
  });

  it("'Remote - Brazil' is closed to a US user but open to one searching Brazil — never excluded", () => {
    const p = posting({ locationRaw: "Remote - Brazil" });
    const us = scorePosting(p, profile("US", ["US"]));
    const br = scorePosting(p, profile("US", ["US", "BR"]));
    expect(us.rulePass).toBe(true);
    expect(us.flags.redFlags.join(" ")).toMatch(/within Brazil/);
    expect(us.breakdown.location).toBeLessThan(br.breakdown.location);
  });
});
