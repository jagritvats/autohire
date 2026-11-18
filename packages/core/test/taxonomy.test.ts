import { describe, expect, it } from "vitest";
import {
  alsoPostedText,
  extractSkills,
  foldSiblings,
  matchSkillToken,
  parseLocation,
  parseResume,
  parseTitle,
  scorePosting,
  siblingGroups,
  stackAdjacency,
  type Posting,
  type Profile,
} from "../src/index.js";

/**
 * Title / skill / level taxonomy and cross-country grouping (2026-11 taxonomy pass, after the
 * fourth-pass feed review). Fictional people, companies and postings only.
 */

describe("titles: data / analytics roles have their own archetype", () => {
  it("analyst, BI and analytics-engineering titles are data_analytics, not other", () => {
    for (const t of ["Data Analyst", "Senior Data Analyst", "Analytics Engineer", "BI Analyst", "Business Intelligence Developer", "Product Analyst", "Marketing Analyst", "Data Analytics Intern", "Senior Manager, Data Analytics", "Statistician"]) {
      expect(parseTitle(t).roleArchetype, t).toBe("data_analytics");
    }
  });
  it("data science / data engineering / ML stay data_ml, even with a team suffix", () => {
    for (const t of ["Data Scientist II, Marketing", "Senior Data Engineer", "Machine Learning Engineer", "Data Scientist, Product Analytics"]) {
      expect(parseTitle(t).roleArchetype, t).toBe("data_ml");
    }
  });
  it("finance / business / security analysts and data-centre work are not analytics roles", () => {
    for (const t of ["Business Analyst", "Financial Analyst", "Security Analyst", "Data Center Operations Analyst"]) {
      expect(parseTitle(t).roleArchetype, t).toBe("other");
    }
  });
});

describe("titles: the non-engineering head noun wins over a tech modifier", () => {
  it("assistant / administrator / support / success roles are not engineering", () => {
    for (const t of ["Executive Assistant - Developer Platform", "Learning Platform & Customer Education Administrator", "Customer Support Developer", "Developer Success Engineer", "Senior Developer Success Engineer"]) {
      expect(parseTitle(t).roleArchetype, t).toBe("other");
    }
  });
  it("…but an engineering head keeps a support-team suffix, and sysadmins are infrastructure", () => {
    expect(parseTitle("Senior Software Engineer, Customer Support Tools").roleArchetype).toBe("backend");
    expect(parseTitle("Linux Systems Administrator").roleArchetype).toBe("infra_devops");
    expect(parseTitle("Database Administrator").roleArchetype).toBe("infra_devops");
  });
  it("a non-engineering role is never filed under the software-engineer title family", () => {
    expect(parseTitle("Executive Assistant - Developer Platform").titleNorm).not.toBe("software-engineer");
    expect(parseTitle("Developer Advocate").titleNorm).not.toBe("software-engineer");
    expect(parseTitle("Senior Backend Developer").titleNorm).toBe("software-engineer");
  });
});

describe("titles: company level ladders (conservative, with confidence)", () => {
  const level = (t: string) => parseTitle(t).levelBand;
  it("numbered rungs on any role noun", () => {
    expect(level("Software Engineer 5")).toBe("staff");
    expect(level("ML Scientist 5")).toBe("staff");
    expect(level("Engineer III")).toBe("senior");
    expect(level("SDE-2")).toBe("mid");
    expect(level("Data Scientist II")).toBe("mid");
    expect(level("Analyst I, Example Team")).toBe("junior");
  });
  it("L / E / IC codes map to the common reading, only beside a role noun or as a tag", () => {
    expect(level("L5")).toBe("senior");
    expect(level("Machine Learning Engineer, L4")).toBe("mid");
    expect(level("Software Engineer - E5")).toBe("senior");
    expect(level("Software Engineer (E4)")).toBe("mid");
    expect(level("Engineer, IC4")).toBe("senior");
    expect(level("Software Engineer IC2")).toBe("mid");
    expect(level("IC4")).toBeNull();
    expect(level("E5")).toBeNull();
    expect(level("Grade E5 Technician")).toBeNull();
    expect(parseTitle("Software Engineer - E5").levelConfidence).toBeLessThan(0.6);
    expect(parseTitle("Senior Software Engineer").levelConfidence).toBeGreaterThanOrEqual(0.85);
  });
  it("the MTS ladder: a bare Member of Technical Staff has no level (not 'staff')", () => {
    expect(level("Member of Technical Staff (Software Engineer, Example)")).toBeNull();
    expect(level("Senior Member of Technical Staff")).toBe("senior");
    expect(level("Software Engineering LMTS")).toBe("staff");
    expect(level("Software Engineering PMTS")).toBe("principal");
    expect(level("Staff Software Engineer")).toBe("staff");
  });
});

describe("skills dictionary: whole words, aliases, and the ambiguous ones", () => {
  it("knows data, frontend and iOS skills", () => {
    const jd = "You know SQL, Tableau or Power BI, Looker, pandas and dbt; Vue.js or Next.js with CSS, HTML and Sass; tests in Jest, Cypress or Playwright; designs from Figma.";
    expect(extractSkills(jd)).toEqual(expect.arrayContaining(["sql", "tableau", "power_bi", "looker", "pandas", "dbt", "vue", "nextjs", "css", "html", "sass", "jest", "cypress", "playwright", "figma"]));
    expect(extractSkills("Build iOS apps in Swift and SwiftUI; maintain Objective-C modules.")).toEqual(expect.arrayContaining(["swift", "swiftui", "objective_c"]));
  });
  it("aliases collapse: Postgres / PostgreSQL, NextJS / Next.js, MS Excel", () => {
    expect(matchSkillToken("PostgreSQL")).toBe("postgres");
    expect(matchSkillToken("Postgres")).toBe("postgres");
    expect(matchSkillToken("Next.js")).toBe("nextjs");
    expect(matchSkillToken("NextJS")).toBe("nextjs");
    expect(matchSkillToken("Node.js")).toBe("javascript");
    expect(matchSkillToken("Power BI")).toBe("power_bi");
    expect(matchSkillToken("MS Excel")).toBe("excel");
    expect(matchSkillToken("R")).toBe("r");
    expect(matchSkillToken("C")).toBe("c");
    expect(matchSkillToken("C#")).toBe("csharp");
  });
  it("C vs C# vs C++, R vs a capital letter, Go vs the verb, Swift vs SWIFT, Excel vs excel at", () => {
    expect(extractSkills("Embedded C and C/C++ on an RTOS")).toEqual(expect.arrayContaining(["c", "cpp"]));
    expect(extractSkills("Services in C# and .NET")).not.toContain("c");
    expect(extractSkills("Plan C, section C. Grade C")).not.toContain("c");
    expect(extractSkills("Analysis in Python or R; SQL daily")).toEqual(expect.arrayContaining(["python", "r", "sql"]));
    expect(extractSkills("Example(R) products; R&D budget; Section R")).not.toContain("r");
    expect(extractSkills("go-to-market plans; we go live in May")).not.toContain("go");
    expect(extractSkills("Payments over SWIFT messages; a swift response")).not.toContain("swift");
    expect(extractSkills("You excel at stakeholder work")).not.toContain("excel");
    expect(extractSkills("Models in Excel and Google Sheets")).toContain("excel");
    expect(extractSkills("MySQL, NoSQL stores")).not.toContain("sql");
    expect(extractSkills("Frequently cited statistics show that people hesitate to apply")).not.toContain("statistics");
    expect(extractSkills("A degree in Mathematics, Statistics, Economics or similar")).toContain("statistics");
  });
  it("React no longer swallows Next.js", () => {
    expect(extractSkills("Next.js app router")).toContain("nextjs");
    expect(extractSkills("Next.js app router")).not.toContain("react");
  });
});

describe("résumé import extracts every skill the file lists — and only those", () => {
  const ANALYST = `# Example Analyst
Example City, USA · example.analyst@example.com

## Experience
### Data Analytics Intern — Imaginary Retail Co (Summer 2025)
- Built Tableau dashboards on weekly sales; automated a reporting SQL pipeline.
- Cleaned transaction data in Python (pandas).

## Skills
SQL, Python, pandas, Excel, Tableau, Power BI, R, statistics, A/B testing
`;
  const FRONTEND = `# Example Frontend
Example Town, Germany · example.frontend@example.com

## Experience
### Senior Frontend Engineer — Fictional Shop GmbH (2021–present)
- Moved a checkout app to TypeScript and React; Next.js SSR.

## Skills
React, TypeScript, JavaScript, Next.js, Vue, GraphQL, CSS, HTML, Jest, Playwright, Webpack, Node.js, accessibility
`;
  const NOW = new Date("2026-11-18");
  it("an analyst's skills section (was: python only)", () => {
    const d = parseResume(ANALYST, { format: "markdown", now: NOW });
    expect(d.skills.canonical).toEqual(expect.arrayContaining(["sql", "python", "pandas", "excel", "tableau", "power_bi", "r", "statistics", "ab_testing"]));
    expect(d.archetypes).toEqual(["data_analytics"]);
  });
  it("a frontend developer's (was: 4 skills); unknown entries stay unrecognized, nothing invented", () => {
    const d = parseResume(FRONTEND, { format: "markdown", now: NOW });
    expect(d.skills.canonical).toEqual(expect.arrayContaining(["react", "typescript", "javascript", "nextjs", "vue", "graphql", "css", "html", "jest", "playwright", "webpack"]));
    expect(d.skills.unrecognized).toEqual(["accessibility"]);
    // grounded: no skill the file doesn't name
    for (const s of d.skills.canonical) expect(["react", "typescript", "javascript", "nextjs", "vue", "graphql", "css", "html", "jest", "playwright", "webpack"]).toContain(s);
  });
});

describe("stack notes: domains are context, never a missing skill", () => {
  it("fintech is not 'new to you'", () => {
    const r = stackAdjacency(["java", "kafka"], ["java", "kafka", "fintech_domain"]);
    expect(r.note).not.toMatch(/fintech/);
    expect(stackAdjacency(["java", "kafka", "fintech_domain"], ["java", "kafka", "fintech_domain"]).note).toMatch(/You have Kafka and fintech/);
  });
  it("an iOS role names its language", () => {
    const r = stackAdjacency(["swift"], extractSkills("iOS engineer: Swift, SwiftUI, Combine"), { title: "iOS Engineer" });
    expect(r.note).toMatch(/^Main language Swift — you have it/);
  });
  it("a skill typed before the dictionary knew it counts as its id", () => {
    const r = stackAdjacency(["power bi", "Tableau"], ["power_bi", "tableau"]);
    expect(r.note).toMatch(/You have Power BI and Tableau/);
  });
});

describe("location: multi-word cities and cross-region remote lists", () => {
  it("takes a city whole and never a country's first word", () => {
    expect(parseLocation("San Francisco Bay Area or Remote (U.S.)").city).toBe("San Francisco Bay Area");
    expect(parseLocation("New York or Remote (US)").city).toBe("New York");
    expect(parseLocation("Remote (United States)").city).toBeNull();
    expect(parseLocation("Remote (United Kingdom)").city).toBeNull();
    expect(parseLocation("United states").city).toBeNull();
    expect(parseLocation("Remote REMOTE, HYBRID, and ONSITE (UNITED STATES ONLY)").city).toBeNull();
    expect(parseLocation("Remote-North & South America").city).toBeNull();
  });
  it("a remote country list reaching beyond Europe is country_only, not eu_only", () => {
    const l = parseLocation("Remote - Albania; Argentina; Austria; Brazil; Germany; United Kingdom; Uruguay");
    expect(l.remoteGeo).toBe("country_only");
    expect(l.city).toBeNull();
    expect(parseLocation("Remote - Germany; France; Spain").remoteGeo).toBe("eu_only");
    expect(parseLocation("Remote, EMEA").remoteGeo).toBe("eu_only");
  });
});

describe("archetype scoring", () => {
  const profile = (targets: Profile["prefs"]["targetArchetypes"]): Profile =>
    ({
      tenantId: "t", masterResume: "", resumeLatex: "", yoe: 1, levelBand: "junior", profileEmbedding: null, onboardedAt: new Date(),
      prefs: {
        stackProfile: ["sql", "python"], stackMustHaves: [], targetArchetypes: targets, salaryFloor: 0, currency: "USD", locationWeights: [],
        remoteGeoOk: ["worldwide"], relocate: true, homeCountry: "US", markets: ["US"],
        contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      },
    }) as unknown as Profile;
  const posting = (title: string, roleArchetype: Posting["roleArchetype"]): Posting =>
    ({
      id: "p", companyId: "c", companyName: "Example Co", source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "1",
      title, titleNorm: "x", roleArchetype, levelBand: null, jdText: "", jdSkills: [], requirements: [],
      location: { mode: "remote", city: null, country: null, timezone: null, remoteGeo: "worldwide", sponsorship: null, confidence: 0.9 },
      salary: { min: null, max: null, currency: "USD", source: "none", confidence: "low" }, experience: { min: null, max: null },
      applyUrl: null, jdEmbedding: null, postedAt: null, firstSeen: new Date(), lastSeen: new Date(), isActive: true, repostCount: 0,
      status: "active", invalidReason: null, invalidatedAt: null, canonicalId: null, dedupKey: "k",
    }) as unknown as Posting;
  it("a data_ml-only profile (saved before the split) still targets analytics roles", () => {
    expect(scorePosting(posting("Data Analyst", "data_analytics"), profile(["data_ml"])).breakdown.archetype).toBe(1);
  });
  it("an analytics-only profile ranks data science above software engineering, and says so", () => {
    const da = profile(["data_analytics"]);
    const ds = scorePosting(posting("Data Scientist", "data_ml"), da).breakdown.archetype;
    const swe = scorePosting(posting("Backend Engineer", "backend"), da);
    expect(ds).toBeGreaterThan(swe.breakdown.archetype);
    expect(swe.flags.redFlags.join(" ")).toMatch(/software engineering role, not analytics/);
  });
  it("a backend developer sees an analyst role as far, flagged as analytics (not 'not engineering')", () => {
    const r = scorePosting(posting("Data Analyst", "data_analytics"), profile(["backend"]));
    expect(r.breakdown.archetype).toBeLessThanOrEqual(0.15);
    expect(r.flags.redFlags.join(" ")).toMatch(/analytics role/);
  });
  it("a stored 'other' row is re-read with the title normalizer", () => {
    expect(scorePosting(posting("Analytics Engineer", "other"), profile(["data_analytics"])).breakdown.archetype).toBe(1);
  });
});

describe("sibling groups: the same role posted per country", () => {
  const JD = "Example Observability builds open telemetry tooling. You will design ingestion pipelines in Go and Kafka, own reliability, and work across time zones. ".repeat(6);
  const p = (id: string, title: string, loc: string, jd = JD) =>
    ({ id, companyName: "Example Observability", title, location: parseLocation(loc), jdText: jd }) as unknown as Posting;
  it("groups same company + title + JD across countries; keeps level, JD and same-place reqs apart", () => {
    const rows = [
      p("a", "Senior Software Engineer, Ingestion", "Remote - United States"),
      p("b", "Senior Software Engineer, Ingestion", "Remote - United Kingdom"),
      p("c", "Senior Software Engineer, Ingestion", "Remote - Germany"),
      p("d", "Software Engineer, Ingestion", "Remote - Germany"), // another level
      p("e", "Senior Software Engineer, Ingestion", "Remote - Spain", "A different role entirely: frontend dashboards in React, design systems, accessibility. ".repeat(6)),
      p("f", "Senior Software Engineer, Ingestion", "Remote - United States"), // second req at the same place
    ];
    const g = siblingGroups(rows);
    expect(g.get("a")).toBe(g.get("b"));
    expect(g.get("b")).toBe(g.get("c"));
    expect(g.get("d")).not.toBe(g.get("a"));
    expect(g.get("e")).not.toBe(g.get("a"));
    expect(g.get("f")).not.toBe(g.get("a"));
    // stable: input order doesn't change the keys
    expect(siblingGroups([...rows].reverse())).toEqual(g);
  });
  it("folds a ranked list under each group's best member, counting what it folded", () => {
    const ranked = [p("b", "Site Reliability Engineer", "Remote - United Kingdom"), p("x", "Data Analyst", "Austin, TX"), p("a", "Site Reliability Engineer", "Remote - United States")];
    const f = foldSiblings(ranked, (r) => r);
    expect(f.shown.map((r) => r.id)).toEqual(["b", "x"]);
    expect(f.siblings.get(ranked[0]!)!.map((r) => r.id)).toEqual(["a"]);
    expect(f.folded).toBe(1);
    expect(alsoPostedText(["US", "UK", "Germany"])).toBe("Also posted for US, UK and Germany");
    expect(alsoPostedText(["US", "UK", "Germany", "Canada", "Spain"])).toBe("Also posted for US, UK, Germany + 2 more");
  });
});
