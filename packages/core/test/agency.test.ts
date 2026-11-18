import { describe, expect, it } from "vitest";
import { looksLikeAgency } from "../src/match/trust.js";

/** Staffing intermediaries vs real employers (2026-11 discovery audit: 0 agencies were flagged). */
describe("looksLikeAgency", () => {
  const jd = "Build backend services in Go and Postgres. Own features end to end.";
  const agency = (companyName: string, jdText = jd) => looksLikeAgency({ companyName, jdText });

  it("flags intermediary names seen in the audit", () => {
    for (const name of ["HiringBlaze", "Staffision", "Acme Consultancy", "Example HireTech", "Example Hire Tech", "SmartHiring Solutions", "Example Staffing", "Example Talent Acquisition", "Example Recruiting Partners", "Example Headhunters", "Staffify Labs"]) {
      expect(agency(name), name).toBe(true);
    }
  });

  it("flags third-party wording in the JD", () => {
    for (const text of [
      "We are hiring on behalf of our client, a leading fintech.",
      "Our client is a Series B SaaS company in Pune.",
      "Our esteemed client, a product MNC, needs a Java developer.",
      "Hiring for one of our clients in Bengaluru.",
      "Contract: C2C or W2. Rate $70/hr.",
      "Engagement: corp-to-corp only.",
      "You will be on third-party payroll for the first year.",
    ]) {
      expect(agency("Example Corp", `${jd}\n${text}`), text).toBe(true);
    }
  });

  it("does not flag real employers", () => {
    for (const name of ["Tata Consultancy Services", "Boston Consulting Group", "Staffbase", "Recruit Holdings", "Hired", "HireRight", "Stripe", "Infosys", "Accenture"]) {
      expect(agency(name), name).toBe(false);
    }
    // an employer talking about ITS clients is not posting on behalf of one
    expect(agency("Example Corp", `${jd}\nWe build platforms our clients rely on. Join a client-facing team.`)).toBe(false);
  });

  it("an employer describing its own clients or its workforce is not an agency (2026-11 corpus)", () => {
    for (const text of [
      "Help us embed AI into the way we deliver value for our clients.",
      "We are committed to delivering high-quality work for our clients while supporting our team.",
      "Engage in projects that make a meaningful difference for our clients and communities.",
      "Produce analytical reports for our clients to unlock the power of data.",
      "Coordinate site conditions, erection tools, manpower, working hours.",
    ]) {
      expect(agency("Example Energy", `${jd}\n${text}`), text).toBe(false);
    }
    // the recruiter phrasings still count
    expect(agency("Example Talent", `${jd}\nWe are recruiting a Software Engineer for our client, a fast-growing startup.`)).toBe(true);
    expect(agency("Example Corp", `${jd}\nWe are a manpower supply partner for IT firms.`)).toBe(true);
  });
});
