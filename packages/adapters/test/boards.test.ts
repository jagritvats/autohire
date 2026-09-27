import { describe, it, expect } from "vitest";
import { findCountryFacet, relativePosted } from "../src/ats/workday.js";
import { atsCandidates } from "../src/detector/index.js";
import { parseJobviteXml } from "../src/ats/jobvite.js";
import { parseCutshortPage } from "../src/india/cutshort.js";
import { findMegathread, parseHiringThread } from "../src/india/reddit.js";
import { parseWellfoundPage } from "../src/india/wellfound.js";

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
