import { describe, it, expect } from "vitest";
import { normalizePosting } from "@jobflow/core";
import type { RawPosting } from "@jobflow/core";
import { buildIndiaSweTargets, lpaFloorFromInr } from "../src/tier3/targets.js";
import {
  buildNaukriApiUrl,
  buildNaukriSeoUrl,
  ctcBucketsForFloor,
  parseNaukriApiJson,
  parseNaukriHtml,
} from "../src/tier3/naukri.js";
import { buildLinkedInUrl, parseLinkedInJobs } from "../src/tier3/linkedin.js";
import {
  ambitionBoxSlug,
  buildAmbitionBoxUrl,
  parseAmbitionBox,
  parseGlassdoor,
  resolveGlassdoorEmployerId,
} from "../src/tier3/enrich.js";
import { collectObjects, decodeEntities, sliceBalancedBraces } from "../src/tier3/parse.js";

// ── targeting ─────────────────────────────────────────────────────────────────
describe("India SWE targeting", () => {
  it("derives an LPA floor from the profile INR salaryFloor, clamped", () => {
    expect(lpaFloorFromInr(2_000_000)).toBe(20);
    expect(lpaFloorFromInr(0)).toBe(15); // fallback
    expect(lpaFloorFromInr(null)).toBe(15);
    expect(lpaFloorFromInr(500_000_000)).toBe(100); // clamp
  });

  it("builds an interleaved, capped target matrix incl. a remote pass", () => {
    const targets = buildIndiaSweTargets({ minLpa: 20, maxTargets: 6 });
    expect(targets.length).toBe(6);
    expect(targets.every((t) => t.minLpa === 20)).toBe(true);
    // remote ("") facet leads, and the queries vary across the first cells (breadth)
    expect(targets[0]!.location).toBe("");
    expect(new Set(targets.slice(0, 3).map((t) => t.query)).size).toBeGreaterThan(1);
  });

  it("respects an explicit single query+location as a one-cell sweep", () => {
    const targets = buildIndiaSweTargets({ queries: ["staff engineer"], locations: ["bengaluru"], remote: false });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ query: "staff engineer", location: "bengaluru" });
  });
});

// ── Naukri ───────────────────────────────────────────────────────────────────
describe("Naukri", () => {
  it("maps a CTC floor to the good-paying buckets", () => {
    expect(ctcBucketsForFloor(15)).toEqual(["15to25", "25to50", "50to75", "75to100"]);
    expect(ctcBucketsForFloor(0)).toEqual([]);
    expect(ctcBucketsForFloor(200)).toEqual(["75to100"]); // above top band → top band
  });

  it("builds jobapi + SEO URLs with keyword, city, CTC, recency", () => {
    const api = buildNaukriApiUrl({ query: "backend engineer", location: "bengaluru", minLpa: 20, freshnessDays: 7 });
    expect(api).toContain("/jobapi/v3/search?");
    expect(api).toContain("keyword=backend+engineer");
    expect(api).toContain("location=bengaluru");
    expect(api).toContain("ctcFilter=25to50");
    expect(api).toContain("jobAge=7");
    const seo = buildNaukriSeoUrl({ query: "backend engineer", location: "gurgaon", minLpa: 20 });
    expect(seo).toContain("backend-engineer-jobs-in-delhi-ncr"); // NCR mapping
    expect(seo).toContain("k=backend+engineer");
  });

  it("parses the jobapi JSON into RawPostings (id, salary, apply URL, skills)", () => {
    const json = JSON.stringify({
      noOfJobs: 2,
      jobDetails: [
        {
          jobId: "140725014464",
          title: "Senior Software Engineer",
          companyName: "Acme Corp",
          jdURL: "/job-listings-senior-software-engineer-acme-140725014464",
          createdDate: 1_720_000_000_000,
          tagsAndSkills: "java,kafka,microservices",
          ambitionBoxData: { Rating: "3.9", ReviewsCount: "1200" },
          placeholders: [
            { type: "experience", label: "5-8 Yrs" },
            { type: "salary", label: "25-40 Lacs PA" },
            { type: "location", label: "Bengaluru" },
          ],
        },
        {
          jobId: "140725014465",
          title: "Backend Developer",
          companyName: "Beta Systems",
          staticUrl: "https://www.naukri.com/job-listings-backend-beta-140725014465",
          placeholders: [
            { type: "salary", label: "Not disclosed" },
            { type: "location", label: "Pune" },
          ],
        },
      ],
    });
    const jobs = parseNaukriApiJson(json, 25);
    expect(jobs).toHaveLength(2);
    const [a, b] = jobs as [RawPosting, RawPosting];
    expect(a.atsJobId).toBe("140725014464");
    expect(a.source).toBe("naukri");
    expect(a.tier).toBe("tier3");
    expect(a.salaryRaw).toBe("25-40 Lacs PA");
    expect(a.locationRaw).toBe("Bengaluru");
    expect(a.applyUrl).toBe("https://www.naukri.com/job-listings-senior-software-engineer-acme-140725014464");
    expect(a.jdText).toContain("kafka");
    expect(typeof a.postedAt).toBe("string");
    expect(b.salaryRaw).toBeNull(); // "Not disclosed" → null (never invented)

    // end-to-end: the LPA salary survives normalization to an INR band
    const norm = normalizePosting(a);
    expect(norm.salary.currency).toBe("INR");
    expect(norm.salary.min).toBe(2_500_000);
    expect(norm.salary.max).toBe(4_000_000);
  });

  it("parses the rendered SRP DOM as a fallback (data-job-id anchor)", () => {
    const html = `
      <section>
      <div class="srp-jobtuple-wrapper" data-job-id="99887766">
        <a class="title" href="/job-listings-platform-engineer-acme-99887766" title="Platform Engineer">Platform Engineer</a>
        <a class="comp-name">Acme Corp</a>
        <span class="exp-wrap"><span class="expwdth">4-7 Yrs</span></span>
        <span class="sal-wrap"><span class="sal">18-30 Lacs P.A.</span></span>
        <span class="loc-wrap"><span class="locWdth">Hyderabad</span></span>
        <ul class="tags-gt"><li class="dot-gt tag-li">Go</li><li class="tag-li">Kubernetes</li></ul>
        <span class="job-post-day">3 Days Ago</span>
      </div>
      </section>`;
    const jobs = parseNaukriHtml(html, 25);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.atsJobId).toBe("99887766");
    expect(j.title).toBe("Platform Engineer");
    expect(j.companyName).toBe("Acme Corp");
    expect(j.salaryRaw).toContain("18-30");
    expect(j.locationRaw).toBe("Hyderabad");
    expect(j.applyUrl).toContain("/job-listings-platform-engineer-acme-99887766");
  });

  it("returns [] on garbage / empty", () => {
    expect(parseNaukriApiJson("not json")).toEqual([]);
    expect(parseNaukriHtml("")).toEqual([]);
  });
});

// ── LinkedIn ─────────────────────────────────────────────────────────────────
describe("LinkedIn", () => {
  it("builds the guest search URL with geoId + recency + an experience facet matched to YoE", () => {
    const url = buildLinkedInUrl({ query: "software engineer", location: "bengaluru", freshnessDays: 7, experienceYears: 2 });
    expect(url).toContain("/jobs-guest/jobs/api/seeMoreJobPostings/search?");
    expect(url).toContain("keywords=software+engineer");
    expect(url).toContain("geoId=105214831"); // Bengaluru
    expect(url).toContain("f_E=2%2C3%2C4"); // entry → mid-senior for ~2 YoE, not senior-only
    expect(url).toContain("f_TPR=r604800"); // 7d in seconds
  });

  it("parses guest job cards anchored on the job URN", () => {
    const html = `
      <ul>
        <li>
          <div class="base-card job-search-card" data-entity-urn="urn:li:jobPosting:3812345678">
            <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/senior-backend-engineer-at-acme-3812345678?trk=abc">link</a>
            <h3 class="base-search-card__title">Senior Backend Engineer</h3>
            <h4 class="base-search-card__subtitle"><a class="hidden-nested-link">Acme Corp</a></h4>
            <span class="job-search-card__location">Bengaluru, Karnataka, India</span>
            <time class="job-search-card__listdate" datetime="2026-07-01">1 week ago</time>
          </div>
        </li>
      </ul>`;
    const jobs = parseLinkedInJobs(html, 25);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.atsJobId).toBe("3812345678");
    expect(j.source).toBe("linkedin");
    expect(j.title).toBe("Senior Backend Engineer");
    expect(j.companyName).toBe("Acme Corp");
    expect(j.locationRaw).toContain("Bengaluru");
    expect(j.applyUrl).toBe("https://in.linkedin.com/jobs/view/senior-backend-engineer-at-acme-3812345678");
    expect(j.salaryRaw).toBeNull(); // LinkedIn IN cards carry no salary
  });
});

// ── AmbitionBox ──────────────────────────────────────────────────────────────
describe("AmbitionBox", () => {
  it("slugs company names and builds the overview URL", () => {
    expect(ambitionBoxSlug("Tech Mahindra")).toBe("tech-mahindra");
    expect(ambitionBoxSlug("HDFC Bank")).toBe("hdfc-bank");
    expect(buildAmbitionBoxUrl("Acme Corp")).toBe("https://www.ambitionbox.com/overview/acme-corp-overview");
  });

  it("parses ratings + India comp from __NEXT_DATA__ (with JSON-LD cross-check)", () => {
    const next = {
      props: {
        pageProps: {
          aggregatedRatingsData: {
            overallRating: 3.8,
            workLifeBalanceRating: 3.9,
            salaryAndBenefitsRating: 3.4,
            companyCultureRating: 3.6,
            reviewsCount: 12000,
          },
          salariesList: {
            designations: [{ jobProfiles: [{ title: "Software Engineer", avgCtc: 1_800_000, typicalMaxCtc: 2_500_000 }] }],
          },
        },
      },
    };
    const html = `
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "EmployerAggregateRating", ratingValue: "3.8", ratingCount: "12000" })}</script>`;
    const e = parseAmbitionBox(html)!;
    expect(e).not.toBeNull();
    expect(e.source).toBe("ambitionbox");
    expect(e.ratingOverall).toBe(3.8);
    expect(e.ratingWlb).toBe(3.9);
    expect(e.ratingComp).toBe(3.4);
    expect(e.reviewCount).toBe(12000);
    expect(e.cultureSummary).toContain("★");
    expect(e.currency).toBe("INR");
    expect(e.salaryMax).toBe(2_500_000);
  });

  it("falls back to JSON-LD alone when __NEXT_DATA__ is absent", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "EmployerAggregateRating", ratingValue: 4.2, ratingCount: 340 })}</script>`;
    const e = parseAmbitionBox(html)!;
    expect(e.ratingOverall).toBe(4.2);
    expect(e.reviewCount).toBe(340);
  });

  it("returns null when nothing parseable", () => {
    expect(parseAmbitionBox("<html><body>nope</body></html>")).toBeNull();
  });
});

// ── Glassdoor ────────────────────────────────────────────────────────────────
describe("Glassdoor", () => {
  it("resolves the employer id (exact name match wins)", () => {
    const find = JSON.stringify([
      { id: 200, name: "Acme Corp India", reviewCount: 100 },
      { id: 100, name: "Acme Corp", reviewCount: 8500 },
    ]);
    expect(resolveGlassdoorEmployerId(find, "Acme Corp")).toBe("100");
  });

  it("parses ratings + interview difficulty from the Apollo cache", () => {
    const next = {
      props: {
        pageProps: {
          apolloCache: {
            "Employer:100": {
              __typename: "Employer",
              id: 100,
              overallRating: 4.1,
              ratingWorkLifeBalance: 4.0,
              ratingCompensationAndBenefits: 3.7,
              reviewCount: 8500,
            },
            "EmployerInterviews:1": { difficultyRating: 3.1 },
          },
        },
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
    const e = parseGlassdoor(html)!;
    expect(e.source).toBe("glassdoor");
    expect(e.ratingOverall).toBe(4.1);
    expect(e.ratingWlb).toBe(4.0);
    expect(e.ratingComp).toBe(3.7);
    expect(e.reviewCount).toBe(8500);
    expect(e.interviewDifficulty).toContain("average");
  });
});

// ── shared parse helpers ─────────────────────────────────────────────────────
describe("parse helpers", () => {
  it("slices a brace-balanced, string-aware object", () => {
    const s = `junk {"a":1,"b":{"c":"}"}} trailing`;
    const from = s.indexOf("{");
    expect(sliceBalancedBraces(s, from)).toBe('{"a":1,"b":{"c":"}"}}');
  });

  it("deep-collects objects by shape", () => {
    const root = { x: [{ jobId: "1", title: "t" }, { nope: true }], y: { z: { jobId: "2", title: "u" } } };
    const found = collectObjects(root, (o) => o.jobId != null);
    expect(found).toHaveLength(2);
  });

  it("decodes common HTML entities", () => {
    expect(decodeEntities("R&amp;D &#8377;20 &quot;x&quot;")).toBe('R&D ₹20 "x"');
  });
});
