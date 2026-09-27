import { describe, it, expect } from "vitest";
import {
  parseTitle,
  extractSkills,
  parseRequirements,
  parseLocation,
  isIndiaWorkable,
  extractSalaryFromText,
  normCompany,
} from "../src/normalize/index.js";

describe("title parsing", () => {
  it("canonicalizes title + level from messy titles", () => {
    expect(parseTitle("Sr. SDE II").levelBand).toBe("senior");
    expect(parseTitle("Sr. SDE II").titleNorm).toBe("software-engineer"); // SDE → canonical, level stripped
    expect(parseTitle("Staff Software Engineer").titleNorm).toBe("software-engineer");
    expect(parseTitle("Staff Software Engineer").levelBand).toBe("staff");
    expect(parseTitle("Backend Engineering Intern").levelBand).toBe("intern");
    // titleNorm is seniority-independent so phrasings of the same role dedup
    expect(parseTitle("Senior Backend Engineer").titleNorm).toBe(parseTitle("Backend Engineer").titleNorm);
  });

  it("maps engineering archetypes", () => {
    expect(parseTitle("Backend Engineer").roleArchetype).toBe("backend");
    expect(parseTitle("Site Reliability Engineer").roleArchetype).toBe("sre");
    expect(parseTitle("Platform Engineer").roleArchetype).toBe("infra_devops");
  });

  it("does NOT treat DevRel / sales-eng titles as engineering (the non-eng guard)", () => {
    expect(parseTitle("Developer Marketing").roleArchetype).toBe("other");
    expect(parseTitle("Developer Relations Engineer").roleArchetype).toBe("other");
    expect(parseTitle("Sales Engineer").roleArchetype).toBe("other");
  });

  it("normalizes company names for dedup", () => {
    expect(normCompany("Razorpay Technologies Pvt Ltd")).toBe("razorpay");
    expect(normCompany("Stripe, Inc.")).toBe("stripe");
  });
});

describe("skill extraction", () => {
  it("collapses aliases to canonical skills", () => {
    const skills = extractSkills("We use PostgreSQL, Kafka Streams, and Spring Boot.");
    expect(skills).toContain("postgres");
    expect(skills).toContain("kafka");
    expect(skills).toContain("java");
  });

  it("does not false-positive bare 'go' / 'rest' from English boilerplate", () => {
    const skills = extractSkills("You will go above and beyond and handle the rest of the team's needs.");
    expect(skills).not.toContain("go");
    expect(skills).not.toContain("rest");
  });

  it("detects 'go' when it's clearly the language", () => {
    expect(extractSkills("Experience with Go and microservices")).toContain("go");
    expect(extractSkills("Go developer wanted")).toContain("go");
  });

  it("grades requirement strength (must vs nice)", () => {
    const reqs = parseRequirements("Kafka is required. Rust is a nice to have.");
    expect(reqs.find((r) => r.skill === "kafka")?.strength).toBe("must_have");
    expect(reqs.find((r) => r.skill === "rust")?.strength).toBe("nice_to_have");
  });
});

describe("location parsing — the false-positive minefield (§11.3)", () => {
  it("flags us-only 'remote'", () => {
    const loc = parseLocation("Remote", "This is a remote role; must be authorized to work in the US.");
    expect(loc.mode).toBe("remote");
    expect(loc.remoteGeo).toBe("us_only");
  });

  it("recognizes india-ok and worldwide remote", () => {
    expect(parseLocation("Remote - India", "").remoteGeo).toBe("india_ok");
    expect(parseLocation("Remote", "Work from anywhere, fully remote worldwide.").remoteGeo).toBe("worldwide");
  });

  it("parses onsite India cities", () => {
    const loc = parseLocation("Bengaluru, India", "");
    expect(loc.country).toBe("India");
  });

  it("reads sponsorship signals", () => {
    expect(parseLocation("London", "We do not offer visa sponsorship.").sponsorship).toBe(false);
  });
});

describe("location confidence (§11.3) — honest about guesses", () => {
  it("is HIGH for an explicit city + country", () => {
    expect(parseLocation("Bengaluru, India", "").confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("is HIGH for unambiguous worldwide / india-ok remote", () => {
    expect(parseLocation("Remote", "Work from anywhere, fully remote worldwide.").confidence).toBeGreaterThanOrEqual(0.8);
    expect(parseLocation("Remote - India", "").confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("is HIGH when a remote role is explicitly US-only", () => {
    expect(parseLocation("Remote", "Must be authorized to work in the US.").confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("is LOW for a bare 'Remote' with no geo hints", () => {
    expect(parseLocation("Remote", "").confidence).toBeLessThan(0.5);
  });

  it("is LOW when a remote role carries conflicting geo hints", () => {
    // mentions both India and the US → we can't be sure which binds
    const loc = parseLocation("Remote", "Open to India; team is US-based across New York.");
    expect(loc.confidence).toBeLessThan(0.5);
  });
});

describe("isIndiaWorkable (§11.3) — soft view filter, not a hard gate", () => {
  it("includes onsite/hybrid in India and India-ok / worldwide remote", () => {
    expect(isIndiaWorkable(parseLocation("Bengaluru, India", ""))).toBe(true);
    expect(isIndiaWorkable(parseLocation("Remote - India", ""))).toBe(true);
    expect(isIndiaWorkable(parseLocation("Remote", "fully remote worldwide"))).toBe(true);
  });

  it("excludes onsite abroad and US-only remote", () => {
    expect(isIndiaWorkable(parseLocation("Berlin, Germany", ""))).toBe(false);
    expect(isIndiaWorkable(parseLocation("Remote", "US-only, authorized to work in the US"))).toBe(false);
  });
});

describe("direct salary extraction (cascade step 1)", () => {
  it("parses INR LPA ranges", () => {
    const s = extractSalaryFromText("Compensation: ₹28-36 LPA");
    expect(s?.currency).toBe("INR");
    expect(s?.min).toBe(2_800_000);
    expect(s?.max).toBe(3_600_000);
    expect(s?.confidence).toBe("high");
  });

  it("parses USD k ranges", () => {
    const s = extractSalaryFromText("$120k - $160k");
    expect(s?.currency).toBe("USD");
    expect(s?.min).toBe(120_000);
    expect(s?.max).toBe(160_000);
  });

  it("returns null when no salary present", () => {
    expect(extractSalaryFromText("Join our mission-driven team in 2024.")).toBeNull();
  });
});

// Every case here was a real false positive in the corpus: all 89 "INR" salaries were bogus,
// 42 of them `high` — enough to hard-exclude real roles under an INR floor (invariant #4).
describe("salary extraction never invents pay from boilerplate", () => {
  it.each([
    ["INR hint inside ordinary words", "A great workplace with no replacement for ownership. Requires 2 to 5 years."],
    ["years-of-experience range", "Ops Engineer, 2 to 5 years of experience in payments."],
    ["company metric in lakh crore", "PhonePe processes an Annualized Total Payment Value (TPV) of over INR 150 lakh crore."],
    ["a funding round", "We raised $500k from angels and are hiring our first engineer."],
    ["a perk figure", "Perks: a $1,000 learning budget and $500 home-office stipend."],
    ["a lone figure in prose", "Our customers saved $120,000 last year."],
    ["a 401(k)", "Benefits include a 401(k) match and 20 days of PTO."],
  ])("%s", (_label, text) => {
    expect(extractSalaryFromText(text)).toBeNull();
  });

  it("reads RSUs as equity, not rupees — the USD range stays USD", () => {
    const s = extractSalaryFromText("The base salary range for this role is $150,000 - $200,000 plus RSUs.");
    expect(s).toMatchObject({ currency: "USD", min: 150_000, max: 200_000, confidence: "high" });
  });

  it("ignores a signing bonus sitting next to the real salary", () => {
    const s = extractSalaryFromText("Salary: $150k–$190k, plus a $15,000 signing bonus.");
    expect(s).toMatchObject({ min: 150_000, max: 190_000, confidence: "high" });
  });

  it("keeps a pay range whose sentence also mentions bonus", () => {
    const s = extractSalaryFromText("Salary + bonus: $150k–$200k");
    expect(s).toMatchObject({ min: 150_000, max: 200_000 });
  });
});

describe("salary formats the adapters actually emit", () => {
  it.each([
    ["Naukri", "25-40 Lacs PA", { currency: "INR", min: 2_500_000, max: 4_000_000 }],
    ["Naukri spaced", "₹ 8 - 12 Lacs P.A.", { currency: "INR", min: 800_000, max: 1_200_000 }],
    ["Indian grouping", "Rs. 12,00,000 - 18,00,000 per annum", { currency: "INR", min: 1_200_000, max: 1_800_000 }],
    ["crore", "1.2 Cr - 1.5 Cr", { currency: "INR", min: 12_000_000, max: 15_000_000 }],
    ["Wellfound lakhs", "₹15L – ₹25L • 0.1% – 0.5%", { currency: "INR", min: 1_500_000, max: 2_500_000 }],
    ["Ashby tier summary", "€80K – €100K • Offers Equity", { currency: "EUR", min: 80_000, max: 100_000 }],
    ["Himalayas", "USD 120000 - 150000", { currency: "USD", min: 120_000, max: 150_000 }],
    ["scale on one end", "USD 150-200K", { currency: "USD", min: 150_000, max: 200_000 }],
    ["code after a $ range", "$120,000 - $150,000 CAD", { currency: "CAD", min: 120_000, max: 150_000 }],
    ["European grouping", "€60.000 - €80.000", { currency: "EUR", min: 60_000, max: 80_000 }],
    ["Swiss grouping", "CHF 120'000 – 150'000", { currency: "CHF", min: 120_000, max: 150_000 }],
    ["Darwinbox monthly", "INR 50000 - 80000 per month", { currency: "INR", min: 600_000, max: 960_000 }],
  ])("%s: %s", (_label, text, want) => {
    expect(extractSalaryFromText(text, { structured: true })).toMatchObject({ ...want, confidence: "high" });
  });

  it("decodes HTML entities between the ends of a range", () => {
    const s = extractSalaryFromText("Pay range:&nbsp;$150,000&nbsp;&ndash;&nbsp;$200,000 USD");
    expect(s).toMatchObject({ min: 150_000, max: 200_000, confidence: "high" });
  });

  it("reads a Greenhouse pay block through its HTML (was stored as a lone floor)", () => {
    const html =
      '<div class="title">MongoDB’s base salary range for this role in the U.S. is:</div><div class="pay-range">' +
      '<span>$164,000</span><span class="divider">&mdash;</span><span>$323,000 USD</span></div>';
    expect(extractSalaryFromText(html)).toMatchObject({ currency: "USD", min: 164_000, max: 323_000, confidence: "high" });
  });

  it("annualises an hourly rate but never calls it high", () => {
    const s = extractSalaryFromText("Compensation: $50-$70/hr");
    expect(s).toMatchObject({ min: 104_000, max: 145_600, confidence: "medium_high" });
  });

  it("annualises a monthly intern stipend", () => {
    const s = extractSalaryFromText("Stipend: ₹30,000 per month");
    expect(s).toMatchObject({ currency: "INR", min: 360_000, max: null, confidence: "medium_high" });
  });

  it("an 'up to' cap is a ceiling, and can be high", () => {
    const s = extractSalaryFromText("CTC: up to ₹24 LPA");
    expect(s).toMatchObject({ min: null, max: 2_400_000, confidence: "high" });
  });

  it("a single figure is only a soft floor", () => {
    const s = extractSalaryFromText("Base salary from $140,000.");
    expect(s).toMatchObject({ min: 140_000, max: null, confidence: "medium_high" });
  });

  it("reports the union of geo pay tiers", () => {
    const s = extractSalaryFromText(
      "The annual base salary range is: SF/NYC $180,000 - $220,000; Remote US $150,000 - $190,000.",
    );
    expect(s).toMatchObject({ min: 150_000, max: 220_000 });
  });

  it("a bare $ in a Canadian posting is CAD, but not trusted to high", () => {
    const s = extractSalaryFromText("Salary: $120,000 - $140,000", { currencyHint: "CAD" });
    expect(s).toMatchObject({ currency: "CAD", confidence: "medium_high" });
  });

  it("a salary field with no currency borrows the location's, at medium", () => {
    const s = extractSalaryFromText("20-30", { structured: true, currencyHint: "INR" });
    expect(s).toMatchObject({ currency: "INR", min: 2_000_000, max: 3_000_000, confidence: "medium" });
  });
});

describe("multi-word cities keep every word", () => {
  it.each([
    ["San Francisco, CA", "San Francisco"],
    ["New York City", "New York City"],
    ["Tel Aviv, Israel", "Tel Aviv"],
    ["Los Angeles (Hybrid)", "Los Angeles"],
    ["London, UK", "London"],
    ["Bengaluru, Karnataka, India", "Bengaluru"],
  ])("%s → %s", (raw, city) => {
    expect(parseLocation(raw).city).toBe(city);
  });
});
