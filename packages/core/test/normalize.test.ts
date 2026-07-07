import { describe, it, expect } from "vitest";
import {
  parseTitle,
  extractSkills,
  parseRequirements,
  parseLocation,
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
