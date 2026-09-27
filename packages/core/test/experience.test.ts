import { describe, it, expect } from "vitest";
import { parseExperience } from "../src/normalize/index.js";

describe("parseExperience — deterministic YoE (§11.2, no LLM)", () => {
  const cases: Array<[string, { min: number | null; max: number | null }]> = [
    // plain single mentions pin both ends
    ["2 yrs Java", { min: 2, max: 2 }],
    ["3 years backend experience", { min: 3, max: 3 }],
    // ranges
    ["2-4 years", { min: 2, max: 4 }],
    ["5 to 8 years of experience", { min: 5, max: 8 }],
    ["experience: 3–5 yrs", { min: 3, max: 5 }],
    // open-ended lower bounds
    ["3+ years", { min: 3, max: null }],
    ["minimum 3 years", { min: 3, max: null }],
    ["at least 5 years", { min: 5, max: null }],
    ["10+ years of experience", { min: 10, max: null }],
    // capped upper bound
    ["up to 4 years", { min: null, max: 4 }],
    // aggregation: a candidate must clear EVERY stated bar → min is the largest lower bound
    ["2 yrs Java, 3 years backend", { min: 3, max: 3 }],
    ["Requires 4+ years; 2-6 years in distributed systems", { min: 4, max: 6 }],
    ["3+ years of Java; 5+ years of overall experience", { min: 5, max: null }],
    ["5+ years total; 1-2 years with Kafka", { min: 5, max: null }],
    // a preference only counts when nothing else is stated
    ["2-4 years of experience. 7+ years preferred.", { min: 2, max: 4 }],
    ["7+ years preferred", { min: 7, max: null }],
    // phrasings seen on Indian boards
    ["5 plus years of experience", { min: 5, max: null }],
    ["Experience: 5 years+", { min: 5, max: null }],
    ["at least five years of backend work", { min: 5, max: null }],
    ["two to four years", { min: 2, max: 4 }],
    ["Exp: 3-5", { min: 3, max: 5 }],
    ["YOE: 4+", { min: 4, max: null }],
    ["Experience: 10+ years", { min: 10, max: null }],
    ["SDE (3-6 Yrs)", { min: 3, max: 6 }],
    // yoe token
    ["6 YOE required", { min: 6, max: 6 }],
    // nothing to find
    ["We build great products for our customers.", { min: null, max: null }],
  ];

  for (const [jd, expected] of cases) {
    it(`parses ${JSON.stringify(jd)} → ${JSON.stringify(expected)}`, () => {
      expect(parseExperience(jd)).toEqual(expected);
    });
  }

  describe("rejects false positives", () => {
    const falsePositives = [
      "Founded in 2023, we scaled fast.", // calendar year
      "We offer 24/7 on-call support.", // 24/7
      "Bootcamp is 3 months long.", // months, not years
      "Call us at +1 555 0199 today.", // phone digits
      "Running on Node v18 and Postgres 14.", // version numbers
      "Grown 300% over the past 5 years.", // company history, not a requirement
      "Our CEO is 45 years old.", // age
      "We shipped this 2 years ago.", // history
      "There is a 2 year bond with the company.", // service bond
      "Service agreement of 2 years applies.", // bond phrasing
      "Celebrating 20 years of excellence in fintech.", // company history
      "Candidates must be 18 years or older.", // age
      "A 4 year degree in CS.", // degree length
      "Experience: 3 months of internship", // months
      "Educational Qualification: 15 years full time education", // Accenture boilerplate
      "Minimum 15 years of full-time education required", // same, other phrasing
    ];
    for (const jd of falsePositives) {
      it(`ignores ${JSON.stringify(jd)}`, () => {
        expect(parseExperience(jd)).toEqual({ min: null, max: null });
      });
    }

    it("keeps the real requirement even when a false positive is nearby", () => {
      expect(parseExperience("Founded in 2023. We want 4+ years of backend experience.")).toEqual({
        min: 4,
        max: null,
      });
    });
  });
});
