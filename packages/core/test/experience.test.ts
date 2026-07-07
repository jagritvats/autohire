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
    // aggregation across multiple mentions → overall min..max
    ["2 yrs Java, 3 years backend", { min: 2, max: 3 }],
    ["Requires 4+ years; 2-6 years in distributed systems", { min: 2, max: 6 }],
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
