import { describe, expect, it } from "vitest";
import { deriveCompany } from "../src/hn/whoishiring.js";

/** First lines from the live 2026-09 "Who is hiring?" thread that broke the old lede parse. */
describe("HN who-is-hiring company extraction", () => {
  const cases: Array<[string, string]> = [
    ["Acme | Backend Engineer | Remote (India) | $120k", "Acme"],
    ["lovable | stockholm, london (in-person) | full-stack, frontend, backend", "lovable"],
    ["Enveritas (YC S18, non-profit) | Backend Software Engineer | Remote (Global)", "Enveritas"],
    ["Cerity Partners ( https://ceritypartners.com ) | Data Engineer | Full Time | Hybrid NYC", "Cerity Partners"],
    ["Remote (US) Close ( https://close.com ) | Senior/Staff Backend Engineer | Full-time", "Close"],
    ["Cologne, Germany | UMH | Product Engineer | Full-time | 55 - 85k EUR | ONSITE", "UMH"],
    ["NYC | ONSITE (hybrid) Norm Ai, the agentic law company, has a client base with a combined $30 trillion in AUM.", "Norm Ai"],
    ["Paul Scherrer Institut (PSI), Switzerland | Research Software Engineer | ONSITE (CH)", "Paul Scherrer Institut"],
    ["3C Digital Solutions | Terraform Module Developer | REMOTE (US) | Full-time", "3C Digital Solutions"],
    ["Beacon AI builds intelligent systems that make aviation safer and more autonomous.", "Beacon AI"],
    ["SwingVision is the AI tennis, pickleball, and padel app that provides automated stats.", "SwingVision"],
    ["At Tether ( https://tether.io/ ) we're hiring! We envision a world where technology enables freedom.", "Tether"],
    ["Hiring for several roles at StudyTurtle, an edutainment brand building learning videos.", "StudyTurtle"],
    ["Rust developer/software engineer at NLnet foundation in Amsterdam", "NLnet"],
    ["Boston Dynamics | Software Engineer | Waltham, MA", "Boston Dynamics"],
    ["Frequenz Energy-as-a-Service GmbH | Backend Engineer | Berlin", "Frequenz Energy-as-a-Service GmbH"],
  ];
  it.each(cases)("%s → %s", (line, company) => {
    expect(deriveCompany(line)).toBe(company);
  });

  it("falls back to the apply link when the lede is only a role", () => {
    expect(deriveCompany("Senior Python Backend Engineer | REMOTE (EMEA/APAC)\nApply: https://jobs.lever.co/reef-technologies/abc")).toBe(
      "Reef Technologies",
    );
    expect(deriveCompany("Software Engineer — Remote (US Only)\nMore at https://careers.acme.co.uk/jobs/1")).toBe("Acme");
  });

  it("skips comments that aren't job posts", () => {
    expect(deriveCompany("I've created a small page to help you navigate this thread")).toBe("");
    expect(deriveCompany("Location: London, UK\nRemote: Yes\nWilling to relocate: No\nhttps://mycreportfolio.com")).toBe("");
    // a recruiter hiding the employer behind a form link: no company to name
    expect(deriveCompany("Hiring: Senior Software Engineers (LATAM/US/Canada-based)\nhttps://form.jotform.com/123")).toBe("");
  });
});
