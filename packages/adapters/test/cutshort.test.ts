import { describe, expect, it } from "vitest";
import { normalizePosting } from "@jobflow/core";
import { cutshortToRaw, type CsJob } from "../src/india/cutshort.js";

// fictional, minimised from the live `__NEXT_DATA__` shape (2026-11)
const job = (over: Partial<CsJob> = {}): CsJob => ({
  _id: "cs-1",
  headline: "Backend Developer",
  companyDetails: { name: "Leading provider of trading software" },
  sanitizedComment: "<p>Build order-matching services in Java.</p>",
  locationsText: "Bengaluru (Bangalore)",
  ...over,
});

describe("Cutshort: the poster's own 'hiring for a client' flag", () => {
  it("sets postedByAgency at the source when the poster says so", () => {
    const raw = cutshortToRaw(job({ hiringForClient: true }));
    expect(raw.postedByAgency).toBe(true);
    expect(normalizePosting(raw).postedByAgency).toBe(true);
  });

  it("leaves a 'no' to the name/JD rule (recruiters under their own brand often leave it off)", () => {
    const own = cutshortToRaw(job({ hiringForClient: false }));
    expect(own.postedByAgency).toBeUndefined();
    expect(normalizePosting(own).postedByAgency).toBe(false);
    const agency = cutshortToRaw(job({ hiringForClient: false, companyDetails: { name: "Example Staffing Solutions" } }));
    expect(normalizePosting(agency).postedByAgency).toBe(true);
  });

  it("keeps a multi-city listing's cities in India", () => {
    const raw = cutshortToRaw(job({ locationsText: "Bengaluru (Bangalore), Hyderabad, Pune" }));
    expect(normalizePosting(raw).location).toMatchObject({ country: "India", countries: ["IN"] });
  });
});
