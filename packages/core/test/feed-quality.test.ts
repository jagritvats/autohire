import { describe, it, expect } from "vitest";
import { parseTitle, parseLocation, normalizePosting, scopedJobId, parsePostedAt, extractSkills } from "../src/normalize/index.js";
import { scorePosting, postingAgeDays, scoreSourceTrust } from "../src/match/index.js";
import type { Posting, Profile } from "../src/schema/index.js";

/**
 * Regression tests for the three feed-quality failures seen on a live corpus:
 * US-only "remote" roles, senior-only roles, and months-old listings reading as fresh.
 */

function profile(over: Partial<Profile["prefs"]> = {}): Profile {
  return {
    id: "p1",
    tenantId: "t1",
    masterResume: "",
    resumeLatex: "",
    aboutText: "",
    profileEmbedding: null,
    yoe: 2,
    levelBand: "mid",
    prefs: {
      salaryFloor: 0,
      currency: "INR",
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [{ label: "remote", weight: 1 }, { label: "bengaluru", weight: 0.85 }, { label: "india", weight: 0.7 }],
      stackMustHaves: [],
      stackProfile: ["java", "kafka", "postgres", "distributed_systems"],
      remoteGeoOk: ["india_ok", "worldwide", "apac_ok"],
      relocate: true,
      targetArchetypes: ["backend", "platform"],
      ...over,
    },
  };
}

function posting(over: Partial<Posting> = {}): Posting {
  const now = new Date();
  return {
    id: "j1",
    companyId: "c1",
    companyName: "Acme",
    atsType: "greenhouse",
    atsJobId: "1",
    source: "greenhouse",
    tier: "tier1",
    title: "Backend Engineer",
    titleNorm: "software-engineer",
    roleArchetype: "backend",
    levelBand: null,
    jdText: "",
    jdSkills: ["java", "kafka", "postgres"],
    requirements: [],
    location: { mode: "onsite", city: "Bengaluru", country: "India", timezone: "Asia/Kolkata", remoteGeo: "unknown", sponsorship: null, confidence: 0.85 },
    salary: { min: null, max: null, currency: "INR", source: "none", confidence: "low" },
    experience: { min: null, max: null },
    applyUrl: null,
    jdEmbedding: null,
    postedAt: null,
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    status: "active",
    invalidReason: null,
    invalidatedAt: null,
    canonicalId: null,
    dedupKey: "acme|software-engineer|onsite:bengaluru",
    ...over,
  };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("title levels follow the Indian SDE ladder", () => {
  it.each([
    ["SDE-1", "junior"],
    ["SDE II", "mid"],
    ["Software Engineer II", "mid"],
    ["Software Development Engineer 2", "mid"],
    ["Site Reliability Engineer 3", "senior"],
    ["SDE III", "senior"],
    ["Software Engineer, Early Career", "junior"],
    ["Associate Software Engineer", "junior"],
    ["Associate Director, Engineering", "director"],
    ["Senior Associate - Backend", "senior"],
  ])("%s → %s", (title, band) => {
    expect(parseTitle(title).levelBand).toBe(band);
  });

  it("does not read 'Engineer - Infrastructure' as a ladder rung", () => {
    expect(parseTitle("Software Engineer - Infrastructure").levelBand).toBeNull();
  });
});

describe("non-engineering guard catches stems", () => {
  it.each(["Developer Advocate", "Technical Recruiter", "Product Manager - Infrastructure", "Business Operations Associate", "Abuse Investigator"])(
    "%s is not an engineering archetype",
    (title) => {
      expect(parseTitle(title).roleArchetype).toBe("other");
    },
  );
});

describe("location: prose must not invent a US restriction", () => {
  it("'join us' / 'ABOUT US' in a JD does not make a remote role US-only", () => {
    const loc = parseLocation("Remote", "ABOUT US\nWe are a distributed team. Come join us and build with us.");
    expect(loc.remoteGeo).toBe("unknown");
  });

  it("a real 'US' in prose still counts as a (soft, low-confidence) US hint", () => {
    const loc = parseLocation("Remote", "Our team collaborates across the US.");
    expect(loc.remoteGeo).toBe("us_only");
    expect(loc.confidence).toBeLessThan(0.85);
  });

  it("the location field wins over JD perk lines", () => {
    const loc = parseLocation("Bengaluru, Karnataka, India", "We offer a remote-friendly culture and WFH stipend.");
    expect(loc.mode).toBe("onsite");
    expect(loc.country).toBe("India");
  });

  it("a secondary India location keeps a global role India-workable", () => {
    const loc = parseLocation("Remote San Francisco, California; Bengaluru, India", "");
    expect(loc.remoteGeo).toBe("india_ok");
  });

  it("'Remote - Americas' / 'North America' is a restriction, not open remote", () => {
    expect(parseLocation("Remote - North America", "").remoteGeo).toBe("us_only");
    expect(parseLocation("Remote (APAC)", "").remoteGeo).toBe("apac_ok");
  });

  it("recognises tier-2 Indian cities", () => {
    expect(parseLocation("Kochi, Kerala", "").country).toBe("India");
    expect(parseLocation("GIFT City, Gandhinagar", "").country).toBe("India");
  });
});

describe("remote geo restrictions honour remoteGeoOk", () => {
  const usOnly = { mode: "remote" as const, city: null, country: "United States", timezone: null, remoteGeo: "us_only" as const, sponsorship: null, confidence: 0.9 };

  it("an explicit US-only remote is an impossible location (hard exclusion)", () => {
    const r = scorePosting(posting({ location: usOnly }), profile());
    expect(r.rulePass).toBe(false);
    expect(r.flags.hardExclusionReason).toMatch(/restricted/i);
  });

  it("stays rule-passing when the user says US-only remote is OK", () => {
    const r = scorePosting(posting({ location: usOnly }), profile({ remoteGeoOk: ["india_ok", "worldwide", "us_only"] }));
    expect(r.rulePass).toBe(true);
  });

  it("an INFERRED (low-confidence) US-only remote is only down-weighted, never excluded", () => {
    const r = scorePosting(posting({ location: { ...usOnly, confidence: 0.5 } }), profile());
    expect(r.rulePass).toBe(true);
    expect(r.breakdown.location).toBeLessThan(0.5);
  });

  it("onsite abroad without stated sponsorship is discounted and flagged", () => {
    const india = scorePosting(posting(), profile());
    const us = scorePosting(
      posting({ location: { mode: "onsite", city: "Seattle", country: "United States", timezone: null, remoteGeo: "unknown", sponsorship: null, confidence: 0.85 } }),
      profile(),
    );
    expect(us.breakdown.location).toBeLessThan(india.breakdown.location);
    expect(us.flags.redFlags.join(" ")).toMatch(/sponsorship not mentioned/i);
    expect(us.rulePass).toBe(true);
  });
});

describe("seniority scores the JD's asked YoE, not just the title", () => {
  it("an unlevelled title asking 7+ yrs ranks well below one asking 2–4", () => {
    const p = profile();
    const heavy = scorePosting(posting({ title: "Site Reliability Engineer", experience: { min: 7, max: null } }), p);
    const fit = scorePosting(posting({ title: "Backend Engineer", experience: { min: 2, max: 4 } }), p);
    expect(heavy.breakdown.seniority).toBeLessThanOrEqual(0.25);
    expect(fit.breakdown.seniority).toBe(1);
    expect(fit.score - heavy.score).toBeGreaterThanOrEqual(10);
  });

  it("the binding constraint wins: a mid title asking 8+ yrs is still a big gap", () => {
    const r = scorePosting(posting({ levelBand: "mid", experience: { min: 8, max: null } }), profile());
    expect(r.breakdown.seniority).toBeLessThan(0.2);
    expect(r.flags.redFlags.join(" ")).toMatch(/seniority gap/i);
  });

  it("a small YoE stretch (3+ for 2 YoE) is not penalised", () => {
    const r = scorePosting(posting({ experience: { min: 3, max: null } }), profile());
    expect(r.breakdown.seniority).toBe(1);
  });
});

describe("freshness uses the source publish date and re-verification", () => {
  it("a months-old req first seen today is NOT fresh", () => {
    const old = posting({ postedAt: daysAgo(120), firstSeen: new Date() });
    const fresh = posting({ postedAt: daysAgo(2) });
    expect(postingAgeDays(old)).toBeGreaterThan(100);
    const a = scorePosting(old, profile());
    const b = scorePosting(fresh, profile());
    expect(a.breakdown.freshness).toBeLessThan(b.breakdown.freshness);
    expect(a.flags.redFlags.join(" ")).toMatch(/evergreen|filled/i);
  });

  it("a posting not re-verified for weeks is flagged and discounted", () => {
    const r = scorePosting(posting({ postedAt: daysAgo(3), lastSeen: daysAgo(40) }), profile());
    expect(r.flags.redFlags.join(" ")).toMatch(/not re-verified/i);
    expect(r.breakdown.freshness).toBeLessThan(0.6);
  });

  it("falls back to firstSeen when the source gives no date", () => {
    expect(Math.round(postingAgeDays(posting({ postedAt: null, firstSeen: daysAgo(5) })))).toBe(5);
  });
});

describe("normalizer carries posting identity + date safely", () => {
  it("namespaces non-ATS job ids by source so feeds can't collide", () => {
    expect(scopedJobId({ atsType: "unknown", source: "remotive", atsJobId: "123" })).toBe("remotive:123");
    expect(scopedJobId({ atsType: "unknown", source: "remotive", atsJobId: "remotive:123" })).toBe("remotive:123");
    expect(scopedJobId({ atsType: "greenhouse", source: "greenhouse", atsJobId: "123" })).toBe("123");
  });

  it("keeps a sane postedAt and drops junk / future dates", () => {
    expect(parsePostedAt("2026-09-03T13:30:34-04:00")).toBe("2026-09-03T17:30:34.000Z");
    expect(parsePostedAt("not a date")).toBeNull();
    expect(parsePostedAt(new Date(Date.now() + 10 * 86_400_000))).toBeNull();
    const n = normalizePosting({
      source: "remotive", tier: "tier1", atsType: "unknown", atsJobId: "9", companyName: "X", companySlug: null,
      title: "Backend Engineer", jdText: "", jdHtml: null, locationRaw: "Worldwide", applyUrl: null, salaryRaw: null,
      postedAt: "2026-09-20T00:00:00Z", fetchedAt: new Date(), raw: {},
    });
    expect(n.atsJobId).toBe("remotive:9");
    expect(n.postedAt).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("skill dictionary gaps that hid stack mismatches", () => {
  it("does not read JavaScript as Java", () => {
    expect(extractSkills("We use JavaScript and Node.js")).not.toContain("java");
  });

  it("detects PHP / Ruby / C++ so they count as a language requirement", () => {
    expect(extractSkills("Laravel developer (PHP 8)")).toContain("php");
    expect(extractSkills("Ruby on Rails")).toContain("ruby");
    expect(extractSkills("add guardrails to the LLM")).not.toContain("ruby");
    expect(extractSkills("C++ systems")).toContain("cpp");
  });
});

describe("source trust (§3)", () => {
  const jd = "We build payment rails. ".repeat(20);
  it("ranks an ATS-direct posting above the same role re-hosted by a board", () => {
    const direct = scoreSourceTrust(posting({ source: "greenhouse", atsType: "greenhouse", jdText: jd }));
    const board = scoreSourceTrust(posting({ source: "cutshort", atsType: "unknown", jdText: jd }));
    expect(direct.score).toBeGreaterThan(board.score);
  });

  it("credits a board listing whose apply link goes to the company ATS", () => {
    const base = { source: "hirist" as const, atsType: "unknown" as const, jdText: jd };
    const viaAts = scoreSourceTrust(posting({ ...base, applyUrl: "https://jobs.lever.co/cred/abc" }));
    const viaBoard = scoreSourceTrust(posting({ ...base, applyUrl: "https://www.hirist.tech/j/1" }));
    expect(viaAts.score).toBeGreaterThan(viaBoard.score);
  });

  it("flags consultancy postings and repeated reposts without excluding them", () => {
    const r = scorePosting(
      posting({ source: "cutshort", atsType: "unknown", repostCount: 3, jdText: `Hiring on behalf of a client (third-party recruiter). ${jd}` }),
      profile(),
    );
    expect(r.flags.redFlags.join(" ")).toMatch(/staffing agency|consultancy/i);
    expect(r.flags.redFlags.join(" ")).toMatch(/reposted/i);
    expect(r.rulePass).toBe(true);
  });
});

describe("title says SDE, JD says 5+ years — the years decide", () => {
  const raw = (title: string, jd: string, extra: Partial<Parameters<typeof normalizePosting>[0]> = {}) =>
    normalizePosting({
      source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "x", companyName: "Acme", companySlug: "acme",
      title, jdText: jd, jdHtml: null, locationRaw: "Bengaluru, India", applyUrl: null, salaryRaw: null,
      postedAt: null, fetchedAt: new Date(), raw: {}, ...extra,
    });
  const asPosting = (n: ReturnType<typeof raw>) => posting({ title: n.title, levelBand: n.levelBand, experience: n.experience });

  it("an unlevelled 'SDE' asking 5+ years ranks well below one asking 1-3", () => {
    const heavy = scorePosting(asPosting(raw("SDE", "Requirements: 5+ years of backend development in Java.")), profile());
    const fit = scorePosting(asPosting(raw("SDE", "Requirements: 1-3 years of backend development in Java.")), profile());
    expect(heavy.breakdown.seniority).toBeLessThanOrEqual(0.3);
    expect(fit.score - heavy.score).toBeGreaterThanOrEqual(15);
    expect(heavy.flags.redFlags.join(" ")).toMatch(/asks 5\+ yrs/i);
  });

  it("a mid-level title does not rescue a 5+ year ask ('SDE-2', 5+ yrs)", () => {
    const r = scorePosting(asPosting(raw("SDE-2", "Must have 5+ years of experience.")), profile());
    expect(r.breakdown.seniority).toBeLessThanOrEqual(0.3);
  });

  it("the binding requirement wins over a smaller stack-specific ask", () => {
    const n = raw("Backend Engineer", "3+ years with Java. 6+ years of overall software experience.");
    expect(n.experience.min).toBe(6);
  });

  it("4+ years for ~2 YoE is a reachable stretch, not a burial", () => {
    const r = scorePosting(asPosting(raw("Software Engineer", "4+ years of experience")), profile());
    expect(r.breakdown.seniority).toBe(0.6);
    expect(r.rulePass).toBe(true);
  });

  it("reads as overqualified when far above the stated range", () => {
    const r = scorePosting(posting({ experience: { min: 0, max: 2 } }), { ...profile(), yoe: 6, levelBand: "senior" });
    expect(r.breakdown.seniority).toBe(0.6);
    expect(r.flags.levelNote ?? "").toMatch(/overqualified/i);
  });

  it("uses the source's structured seniority when the title has none — title still wins", () => {
    expect(raw("Backend Engineer", "", { levelHint: "mid" }).levelBand).toBe("mid");
    expect(raw("Senior Backend Engineer", "", { levelHint: "mid" }).levelBand).toBe("senior");
  });
});

describe("a board's structured experience beats JD prose", () => {
  it("uses experienceHint over text (Accenture's '15 years full time education')", () => {
    const n = normalizePosting({
      source: "timesjobs", tier: "tier2", atsType: "unknown", atsJobId: "1", companyName: "Accenture", companySlug: null,
      title: "Full Stack Engineer", jdText: "Educational Qualification: 15 years full time education. 7+ years preferred.",
      jdHtml: null, locationRaw: "Pune, India", applyUrl: null, salaryRaw: null, postedAt: null, fetchedAt: new Date(), raw: {},
      experienceHint: { min: 2, max: 5 },
    });
    expect(n.experience).toEqual({ min: 2, max: 5 });
  });
});
