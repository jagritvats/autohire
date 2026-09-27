import { describe, it, expect } from "vitest";
import { parseLevelsCompanyMarketMarkdown, parseLevelsMarketMarkdown } from "../src/enrich/levelsfyi.js";
import { adzunaQuery, summarizeHistogram } from "../src/enrich/adzuna.js";
import { parseAmbitionBox } from "../src/tier3/enrich.js";

// Real summaries from levels.fyi (fetched 2026-09-27), trimmed to the lines we read.
const INDIA_SENIOR = `# Levels.fyi – Software Engineer Salary in India
The median Senior Software Engineer salary in India is ₹4,983,065, based on 8,733 salary submissions.
- Median Total Compensation: ₹4,983,065
- 25th / 75th Percentile: ₹3,286,661 / ₹7,391,397
- 90th Percentile: ₹10,207,956
Most reported packages ... Figures are based on 8,733 salary submissions.`;
const CANADA = `- Median Total Compensation: CA$139,191
- 25th / 75th Percentile: CA$103,874 / CA$188,279
based on 5,921 salary submissions`;
const SINGAPORE = `- Median Total Compensation: SGD 115,712
- 25th / 75th Percentile: SGD 85,392 / SGD 165,909  `;

describe("levels.fyi market summaries", () => {
  it("parses median, p25/p75, sample count and currency", () => {
    expect(parseLevelsMarketMarkdown("IN", "senior", INDIA_SENIOR)).toMatchObject({
      currency: "INR", median: 4_983_065, p25: 3_286_661, p75: 7_391_397, sampleCount: 8733, level: "senior",
    });
  });

  it("reads qualified dollar and code prefixes", () => {
    expect(parseLevelsMarketMarkdown("CA", "all", CANADA)).toMatchObject({ currency: "CAD", median: 139_191, p75: 188_279 });
    expect(parseLevelsMarketMarkdown("SG", "all", SINGAPORE)).toMatchObject({ currency: "SGD", median: 115_712, p25: 85_392 });
  });

  it("returns null for a 404 / redesigned page instead of guessing", () => {
    expect(parseLevelsMarketMarkdown("IN", "senior", "<!DOCTYPE html><title>404 Page Not Found</title>")).toBeNull();
  });
});

describe("Adzuna benchmark", () => {
  it("puts the level word in the query", () => {
    expect(adzunaQuery("backend", 3)).toBe("senior backend engineer");
    expect(adzunaQuery("backend", 2)).toBe("backend engineer");
    expect(adzunaQuery("sre", null)).toBe("site reliability engineer");
  });

  it("interpolates percentiles inside histogram buckets (keys are bucket floors)", () => {
    // 100 ads: 25 in [10k,20k), 50 in [20k,30k), 25 in [30k,40k)
    const s = summarizeHistogram({ "10000": "25", "20000": "50", "30000": "25" })!;
    expect(s.n).toBe(100);
    expect(s.p25).toBe(20_000);
    expect(s.p50).toBe(25_000);
    expect(s.p75).toBe(30_000);
  });

  it("ignores empty buckets and junk keys", () => {
    expect(summarizeHistogram({})).toBeNull();
    expect(summarizeHistogram({ abc: "3", "10000": "0" })).toBeNull();
  });
});

describe("AmbitionBox per-designation pay", () => {
  it("keeps each designation's CTC and its level", () => {
    const next = {
      props: {
        pageProps: {
          aggregatedRatingsData: { overallRating: 3.9, reviewsCount: 5000 },
          salariesList: {
            designations: [
              { jobProfiles: [{ title: "Software Engineer", avgCtc: 1_600_000, typicalMinCtc: 900_000, typicalMaxCtc: 2_400_000, salariesCount: 820 }] },
              { jobProfiles: [{ title: "Senior Software Engineer", avgCtc: 3_100_000, typicalMaxCtc: 4_500_000 }] },
              { jobProfiles: [{ title: "Business Analyst", avgCtc: 1_200_000 }] },
            ],
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
    const e = parseAmbitionBox(html)!;
    expect(e.compRoles).toEqual([
      { title: "Software Engineer", levelBand: null, median: 1_600_000, lo: 900_000, hi: 2_400_000, n: 820 },
      { title: "Senior Software Engineer", levelBand: "senior", median: 3_100_000, lo: null, hi: 4_500_000, n: null },
    ]);
  });
});

// ── levels.fyi company × market (trimmed from the live pages, 2026-09-27) ──
const AMAZON_IN = `# Levels.fyi – Amazon Software Engineer Salaries in India
**Currency:** INR (₹)
## Aggregate Highlights
- Median Total Compensation: ₹6,284,000  
---
## Key Breakdowns

### Levels Breakdown
| Level | Median Total Compensation |
| --- | --- |
| L4 | ₹2,793,748 |
| L5 | ₹6,640,622 |
| L6 | ₹13,182,852 |
| L7 | ₹23,637,837 |

---
### What level is a Senior Software Engineer at Amazon?
A Senior Software Engineer at Amazon is level L6, Senior SDE. Median total compensation at L6 is ₹13,182,852 per year on Levels.fyi.
Software Engineers at Amazon L4 in India typically have around 2 years of experience, based on salary submissions to Levels.fyi.
Software Engineers at Amazon L5 in India typically have 6–7 years of experience, based on salary submissions to Levels.fyi.
Software Engineers at Amazon L6 in India typically have 11–12 years of experience, based on salary submissions to Levels.fyi.
The median pay mix for Software Engineer at Amazon in India is ₹5,386,286 base salary, ₹897,714 in stock per year. Stock is reported as annualized grant value.`;

const CITI_IN = `# Levels.fyi – Citi Software Engineer Salaries in India
**Currency:** INR (₹)
- Median Total Compensation: ₹2,906,844  
### Levels Breakdown
| Level | Median Total Compensation |
| --- | --- |
| C10 | ₹2,244,304 |
| C11 | ₹2,966,885 |
| C12 | ₹4,113,158 |
| VP | ₹5,518,279 |
---
Software Engineers at Citi C10 in India typically have 3–4 years of experience, based on salary submissions to Levels.fyi.
Software Engineers at Citi C11 in India typically have 5–6 years of experience, based on salary submissions to Levels.fyi.
Software Engineers at Citi C12 in India typically have 10–11 years of experience, based on salary submissions to Levels.fyi.
Software Engineers at Citi VP in India typically have 13–14 years of experience, based on salary submissions to Levels.fyi.`;

describe("levels.fyi company × market ladder", () => {
  it("places the employer's levels on our ladder, pinning its 'Senior'", () => {
    const a = parseLevelsCompanyMarketMarkdown("amazon", "IN", AMAZON_IN)!;
    expect(a.currency).toBe("INR");
    expect(a.medianAll).toBe(6_284_000);
    expect(a.levels.map((l) => [l.name, l.index])).toEqual([["L4", 1], ["L5", 2], ["L6", 3], ["L7", 5]]);
    expect(a.levels[1]).toMatchObject({ median: 6_640_622, yoe: 6.5 });
    // India CTC ≈ base (+ bonus); stock excluded → 5.39 ÷ (5.39 + 0.90)
    expect(a.postedShare).toBeCloseTo(0.86, 2);
  });

  it("falls back to years alone when no 'Senior' level is named, and non-L level names work", () => {
    const c = parseLevelsCompanyMarketMarkdown("citi", "IN", CITI_IN)!;
    expect(c.levels.map((l) => [l.name, l.index])).toEqual([["C10", 2], ["C11", 3], ["C12", 4], ["VP", 5]]);
    expect(c.postedShare).toBeNull(); // no pay mix on the page — never guessed
  });

  it("a 404 page is null", () => {
    expect(parseLevelsCompanyMarketMarkdown("hevo-data", "IN", "<!DOCTYPE html><title>404</title>")).toBeNull();
  });
});
