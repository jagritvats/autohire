import { describe, it, expect } from "vitest";
import { findCountryFacet, relativePosted } from "../src/ats/workday.js";
import { atsCandidates } from "../src/detector/index.js";
import { parseJobviteXml } from "../src/ats/jobvite.js";
import { parseCutshortPage } from "../src/india/cutshort.js";
import { findMegathread, parseHiringThread } from "../src/india/reddit.js";
import { parseWellfoundPage } from "../src/india/wellfound.js";
import { findCountrySites } from "../src/ats/workday.js";
import { parseEightfoldSlug, v2Row } from "../src/ats/eightfold.js";
import { parseJibeJobs } from "../src/ats/jibe.js";
import { jobPostingLd, parseTalentBrewResults, talentBrewDate } from "../src/ats/talentbrew.js";

describe("Workday country facet discovery (facet names vary by tenant)", () => {
  it("finds a flat Location_Country facet (Target-style)", () => {
    const facets = [
      { facetParameter: "Location_Region_State_Province", values: [{ descriptor: "Indiana", id: "x1", count: 258 }] },
      { facetParameter: "Location_Country", values: [{ descriptor: "India", id: "c4f7", count: 64 }] },
    ];
    expect(findCountryFacet(facets, "India")).toEqual({ param: "Location_Country", id: "c4f7" });
  });

  it("finds a nested locationHierarchy1 facet and ignores 'India, Bengaluru' (Nvidia-style)", () => {
    const facets = [
      {
        facetParameter: "locationMainGroup",
        values: [
          { facetParameter: "locations", values: [{ descriptor: "India, Bengaluru", id: "city", count: 198 }] },
          { facetParameter: "locationHierarchy1", values: [{ descriptor: "India", id: "2fcb", count: 243 }] },
        ],
      },
    ];
    expect(findCountryFacet(facets, "India")).toEqual({ param: "locationHierarchy1", id: "2fcb" });
  });

  it("returns null when the tenant has no roles in that country", () => {
    expect(findCountryFacet([{ facetParameter: "Location_Country", values: [{ descriptor: "Indiana", id: "x" }] }], "India")).toBeNull();
  });

  it("reads relative 'posted' labels", () => {
    const now = Date.UTC(2026, 8, 27);
    expect(relativePosted("Posted Today", now)).toBe("2026-09-27T00:00:00.000Z");
    expect(relativePosted("Posted Yesterday", now)).toBe("2026-09-26T00:00:00.000Z");
    expect(relativePosted("Posted 14 Days Ago", now)).toBe("2026-09-13T00:00:00.000Z");
    expect(relativePosted("Posted 30+ Days Ago", now)).toBe("2026-08-28T00:00:00.000Z");
    expect(relativePosted(undefined, now)).toBeNull();
  });
});

describe("ATS candidate extraction (URLs and careers-page HTML)", () => {
  it("encodes multi-part slugs for Workday and Eightfold", () => {
    expect(atsCandidates("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x")[0]).toEqual({
      ats: "workday",
      slug: "nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite",
    });
    expect(atsCandidates("https://apply.careers.microsoft.com/careers?domain=microsoft.com")[0]).toEqual({
      ats: "eightfold",
      slug: "apply.careers.microsoft.com/microsoft.com",
    });
  });

  it("cuts an HTML-embedded slug at the closing quote and skips script paths", () => {
    const html = `<script src="https://boards.greenhouse.io/embed/job_board/js?for=x"></script>
      <a href="https://boards.greenhouse.io/razorpaysoftwareprivatelimited">Jobs</a>`;
    const c = atsCandidates(html);
    expect(c.map((x) => x.slug)).toContain("razorpaysoftwareprivatelimited");
    expect(c.map((x) => x.slug)).not.toContain("embed");
    expect(c.some((x) => x.slug.includes('"'))).toBe(false);
  });

  it("does not read Workday's API path as a site", () => {
    const c = atsCandidates("https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/jobs");
    expect(c.find((x) => x.ats === "workday")).toBeUndefined();
  });
});

describe("Cutshort listing parse", () => {
  it("pulls jobs out of __NEXT_DATA__ and tolerates missing data", () => {
    const next = {
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              { state: { data: { data: { pageData: { jobs: [{ _id: "a1", headline: "Backend Developer", expRange: { min: 2, max: 4 } }] } } } } },
            ],
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
    expect(parseCutshortPage(html).map((j) => j._id)).toEqual(["a1"]);
    expect(parseCutshortPage("<html>no data</html>")).toEqual([]);
  });
});

describe("India-market / big-employer ATS URL forms", () => {
  it.each([
    ["https://careers.kula.ai/cashfree", "kula", "cashfree"],
    ["https://signzy.keka.com/careers", "keka", "signzy"],
    ["https://wissen.zohorecruit.in/jobs/Careers", "zoho", "wissen.zohorecruit.in"],
    ["https://careers.yellow.ai/jobs/Careers", "zoho", "careers.yellow.ai"],
    ["https://everstage.freshteam.com", "freshteam", "everstage"],
    ["https://ats.rippling.com/copado/jobs", "rippling", "copado"],
    ["https://jobs.jobvite.com/nutanix/jobs", "jobvite", "nutanix"],
    ["https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/123", "oracle", "jpmc.fa.oraclecloud.com/CX_1001"],
    ["https://www.atlassian.com/company/careers/details/25540", "atlassian", "atlassian"],
  ])("%s → %s/%s", (url, ats, slug) => {
    expect(atsCandidates(url)[0]).toEqual({ ats, slug });
  });
});

describe("Jobvite XML feed parse", () => {
  it("reads CDATA + entity-escaped fields", () => {
    const xml = `<?xml version="1.0"?><result><job><id>oNhEAfw2</id><title>Software Engineer 2</title><category>Engineering</category><region>India</region><location>Bangalore, India</location><date>8/27/2026</date><apply-url><![CDATA[http://app.jobvite.com/x?j=oNhEAfw2&k=Apply]]></apply-url><description>&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;</description></job></result>`;
    const [j] = parseJobviteXml(xml);
    expect(j).toMatchObject({ id: "oNhEAfw2", region: "India", location: "Bangalore, India", date: "8/27/2026" });
    expect(j!.applyUrl).toBe("http://app.jobvite.com/x?j=oNhEAfw2&k=Apply");
    expect(j!.description).toContain("<p>Build");
  });
});

describe("r/developersIndia hiring thread", () => {
  const enc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  it("finds the monthly megathread in search results", () => {
    const atom = `<feed><entry><title>Some other post</title><link href="https://www.reddit.com/r/x/comments/1/other/" /></entry>
      <entry><title>Who&#39;s hiring? - Monthly Megathread - September 2026</title><link href="https://www.reddit.com/r/developersIndia/comments/1w41kof/whos_hiring/" /></entry></feed>`;
    expect(findMegathread(atom)).toBe("https://www.reddit.com/r/developersIndia/comments/1w41kof/whos_hiring/");
  });

  it("splits a comment with two templated postings", () => {
    const body = enc(
      "<p>Company Name: Acme Pay</p><p>Location: Bengaluru</p><p>Role/Position: Backend Engineer</p><p>Experience Required: 2-4 years</p><p>Pay Range: 20-30 LPA</p><p>Application Link / Contact Email: https://jobs.lever.co/acme/123</p>" +
        "<p>Company Name: Beta</p><p>Location: Remote (India)</p><p>Role/Position: SDE 1</p><p>Experience Required: 0-2 years</p>",
    );
    const atom = `<feed><entry><id>t1_abc</id><updated>2026-09-03T10:00:00+00:00</updated><content type="html">${body}</content></entry></feed>`;
    const posts = parseHiringThread(atom);
    expect(posts.map((p) => p.companyName)).toEqual(["Acme Pay", "Beta"]);
    expect(posts[0]).toMatchObject({ title: "Backend Engineer", applyUrl: "https://jobs.lever.co/acme/123", salaryRaw: "20-30 LPA", locationRaw: "Bengaluru" });
    expect(posts[1]!.atsJobId).toBe("t1_abc#1");
  });
});

describe("Wellfound page parse", () => {
  it("reads the Apollo cache behind a crossorigin script tag and skips reposters", () => {
    const data = {
      "StartupResult:1": { name: "Acme", highlightedJobListings: [{ __ref: "JobListingSearchResult:10" }] },
      "JobListingSearchResult:10": { id: "10", title: "Backend Engineer", slug: "backend-engineer", liveStartAt: 1790380800, yearsExperienceMin: 2, locationNames: ["Bengaluru"], remote: false, description: "Build APIs." },
      "JobListingSearchResult:11": { id: "11", title: "Backend Engineer", description: "**Apply here**: https://devsunite.com/jobs/x" },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">${JSON.stringify({ props: { pageProps: { apolloState: { data } } } })}</script>`;
    const parsed = parseWellfoundPage(html)!;
    expect(parsed.postings.map((p) => p.atsJobId)).toEqual(["10"]);
    expect(parsed.postings[0]).toMatchObject({ companyName: "Acme", experienceHint: { min: 2, max: null } });
  });
});

describe("Workday tenants without a country facet (Comcast-style)", () => {
  it("collects location values named for the country, never Indiana/Indianapolis", () => {
    const facets = [
      { facetParameter: "jobFamilyGroup", values: [{ descriptor: "Engineering", id: "f1" }] },
      {
        facetParameter: "locationMainGroup",
        values: [
          {
            facetParameter: "locations",
            values: [
              { descriptor: "India - Chennai, Comcast India Engineering Cent", id: "chn", count: 30 },
              { descriptor: "India – Virtual – Karnataka DTA", id: "virt", count: 1 },
              { descriptor: "IN - Indianapolis, 5330 E 65th St", id: "indy", count: 7 },
              { descriptor: "WA - Spokane, 13826 East Indiana Ave", id: "spk", count: 1 },
              { descriptor: "Pune, India", id: "pune", count: 2 },
            ],
          },
        ],
      },
    ];
    expect(findCountrySites(facets, "India")).toEqual({ param: "locations", ids: ["chn", "virt", "pune"] });
    expect(findCountrySites(facets, "Germany")).toBeNull();
  });
});

describe("Eightfold: PCSX vs the older /api/apply/v2 (slug marker)", () => {
  it("tells the two APIs apart by the slug", () => {
    expect(parseEightfoldSlug("apply.careers.microsoft.com/microsoft.com")).toEqual({ host: "apply.careers.microsoft.com", domain: "microsoft.com", api: "pcsx" });
    expect(parseEightfoldSlug("portal.careers.hsbc.com/hsbc.com/v2")).toEqual({ host: "portal.careers.hsbc.com", domain: "hsbc.com", api: "v2" });
    expect(parseEightfoldSlug("x.eightfold.ai/x.com/v9")).toBeNull();
    expect(parseEightfoldSlug("x.eightfold.ai")).toBeNull();
  });

  it("maps a v2 listing (snake_case, t_create as the publish date)", () => {
    const row = v2Row({
      id: 44220066,
      name: "Software Engineer (C/ C++ Storage)",
      location: "Bangalore, India Office (BANGALORE)",
      locations: ["Bangalore, India Office (BANGALORE)"],
      t_create: 1787916729,
      work_location_option: "hybrid",
      canonicalPositionUrl: "https://netapp.eightfold.ai/careers/job/44220066",
    });
    expect(row).toMatchObject({ id: 44220066, where: "Bangalore, India Office (BANGALORE)", mode: "hybrid", postedTs: 1787916729, url: "https://netapp.eightfold.ai/careers/job/44220066" });
    expect(v2Row({ id: 1, name: "X", location: "Pune, Maharashtra, India" }).where).toBe("Pune, Maharashtra, India");
  });
});

describe("iCIMS Jibe job rows", () => {
  it("reads plain-text and HTML JDs, extra locations, the colon-less offset, and dedupes", () => {
    const rows = [
      {
        req_id: "473552",
        slug: "473552",
        title: "Software Engineer II",
        description: "Overview We are PepsiCo. Responsibilities Build services. Qualifications 2+ years Java",
        responsibilities: "Build services.",
        city: "Hyderabad",
        state: "Telangana",
        country: "India",
        hiring_organization: "PepsiCo",
        posted_date: "2026-09-21T12:44:00+0000",
        meta_data: { canonical_url: "https://www.pepsicojobs.com/jobs/473552?lang=en-us" },
      },
      {
        req_id: 54381,
        title: "R&D Engineer 1, Software",
        description: "<STRONG>Overview</STRONG><br><p>Keysight builds <b>test</b> tools.</p>",
        qualifications: "<ul><li>C++ or Python</li></ul>",
        city: "Gurgaon",
        state: "Haryana",
        country: "India",
        additional_locations: [{ city: "Bangalore", state: "Karnataka", country: "India" }],
        posted_date: "2026-09-23T01:30:00+0000",
      },
      { req_id: "473552", title: "Software Engineer II (dup)" },
    ];
    const out = parseJibeJobs(rows, "www.pepsicojobs.com", "India");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      atsType: "jibe",
      atsJobId: "473552",
      companyName: "PepsiCo",
      locationRaw: "Hyderabad, Telangana, India",
      applyUrl: "https://www.pepsicojobs.com/jobs/473552?lang=en-us",
      postedAt: "2026-09-21T12:44:00.000Z",
      jdHtml: null,
    });
    // the responsibilities are already inside the description — not appended twice
    expect(out[0]!.jdText).toBe("Overview We are PepsiCo. Responsibilities Build services. Qualifications 2+ years Java");
    expect(out[1]).toMatchObject({ atsJobId: "54381", locationRaw: "Gurgaon, Haryana, India; Bangalore, Karnataka, India", companyName: "pepsicojobs" });
    expect(out[1]!.jdText).toContain("Keysight builds test tools.");
    expect(out[1]!.jdText).toContain("C++ or Python");
    expect(out[1]!.jdHtml).toContain("<STRONG>Overview</STRONG>");
  });
});

describe("Radancy TalentBrew search results + job-page JSON-LD", () => {
  it("parses both tenant templates (h2 + job-location span, data-title attr)", () => {
    const optum = `<section id="search-results" data-total-results="252" data-total-pages="3" data-current-page="1"><ul><li>
      <a href="/job/hyderabad/senior-software-engineer-ii/34088/101107209952" data-job-id="101107209952" class="brand-facet">
      <div><h2>Senior Software Engineer II</h2><span class="job-id job-info">2389006</span><span class="job-divider"> | </span>
      <span class="job-location 1">Hyderabad, Telangana</span></div></a></li></ul></section>`;
    const intuit = `<section data-total-results="29" data-total-pages="1"><ul class="search-list"><li>
      <a href="/job/bengaluru/senior-staff-engineer-pdx/27595/100377650384" data-job-id="23933" class="sr-item" data-title="Senior Staff Engineer &#x2014; PDX">
      <h2>Senior Staff Engineer &#x2014; Intuit Agent Ready Platform, PDX</h2>
      <span class="job-location">Bangalore, India</span></a>
      <button class="js-save-job-btn" data-job-id="100377650384"></button></li></ul></section>`;
    const a = parseTalentBrewResults(optum);
    expect(a).toMatchObject({ total: 252, pages: 3 });
    expect(a.items).toEqual([
      { path: "/job/hyderabad/senior-software-engineer-ii/34088/101107209952", jobId: "101107209952", title: "Senior Software Engineer II", location: "Hyderabad, Telangana" },
    ]);
    const b = parseTalentBrewResults(intuit);
    expect(b.items[0]).toMatchObject({ jobId: "100377650384", title: "Senior Staff Engineer — Intuit Agent Ready Platform, PDX", location: "Bangalore, India" });
    expect(parseTalentBrewResults("").items).toEqual([]);
  });

  it("reads the JobPosting JSON-LD and its unpadded dates", () => {
    const html = `<html><script type="application/ld+json">{"@context":"http://schema.org","@type":"Organization","name":"x"}</script>
      <script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting","datePosted":"2026-9-3","identifier":"2388347",
      "description":"<p>Build APIs in Java</p>","jobLocation":[{"@type":"Place","address":{"addressLocality":"Hyderabad","addressRegion":"Telangana","addressCountry":"India"}}]}</script></html>`;
    const jp = jobPostingLd(html)!;
    expect(jp).toMatchObject({ identifier: "2388347", description: "<p>Build APIs in Java</p>" });
    expect(talentBrewDate(jp.datePosted)).toBe("2026-09-03T00:00:00.000Z");
    expect(talentBrewDate("2026-12-25")).toBe("2026-12-25T00:00:00.000Z");
    expect(talentBrewDate(undefined)).toBeNull();
    expect(jobPostingLd("<html>no data</html>")).toBeNull();
  });
});

describe("career-site platforms detected from the page itself", () => {
  it("names the page host as the board when the platform's assets are on it", () => {
    const jibe = `<img src="https://cms.jibecdn.com/prod/pepsico-main/assets/LOGO.png">`;
    const tb = `<link href="https://tbcdn.talentbrew.com/company/34088/css/site.css" rel="stylesheet">`;
    expect(atsCandidates(jibe, "https://www.pepsicojobs.com/main/jobs")).toEqual([{ ats: "jibe", slug: "www.pepsicojobs.com" }]);
    expect(atsCandidates(tb, "https://careers.unitedhealthgroup.com/search-jobs")).toEqual([{ ats: "talentbrew", slug: "careers.unitedhealthgroup.com" }]);
    expect(atsCandidates(tb)).toEqual([]); // no page URL, no host to name
    // a linked ATS board on the same page is tried first
    const both = `${tb}<a href="https://boards.greenhouse.io/acme">jobs</a>`;
    expect(atsCandidates(both, "https://jobs.acme.com/").map((c) => c.ats)).toEqual(["greenhouse", "talentbrew"]);
  });
});
