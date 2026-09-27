import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePosting } from "@jobflow/core";
import {
  DARWINBOX_PAGE_SIZE,
  darwinboxCareersUrl,
  darwinboxJobsApiUrl,
  darwinboxJobsBody,
  darwinboxJobUrl,
  parseDarwinboxJobs,
  parseDarwinboxSlug,
} from "../src/tier3/darwinbox.js";
import {
  buildPeerlistUrl,
  parsePeerlistPage,
  peerlistJobUrl,
  peerlistRoleFor,
  peerlistTitleSlug,
} from "../src/tier3/peerlist.js";
import { consultantFlag, naukriIdDate, originalPostedAt, parseNaukriApiJson, relativeLabelIso } from "../src/tier3/naukri.js";
import {
  DarwinboxAdapter,
  PeerlistAdapter,
  Tier3DisabledError,
  WellfoundLocalAdapter,
  wellfoundRoleFor,
  type LocalFetchInit,
  type Tier3Context,
} from "../src/tier3/index.js";
import { atsCandidates, detectFromUrl } from "../src/detector/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Darwinbox ────────────────────────────────────────────────────────────────
// Shape copied from the live `POST /ms/candidateapi/job/alljobs` response (2026-09-27),
// trimmed to the fields the parser reads.
function dbxJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "6ab61541dadb173e0b0ac08d",
    id: "a6ab615414a427",
    designation_display_name: "Application Security Engineer-2",
    internal_job_code: "UP0141",
    experience_from: "3",
    experience_to: "5",
    experience: "3 - 5 Years",
    salary_currency: "",
    salary_min: "",
    salary_max: "",
    salary_range: "",
    salary_timeframe: "Annual",
    jd: "&lt;p&gt;&lt;b&gt;Security Engineer 2 — AppSec&lt;/b&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Threat modelling &amp;amp; code review for Java / Go services&lt;/li&gt;&lt;/ul&gt;",
    officelocations_without_area: ["Mumbai, Maharashtra\r, India", "Bangalore, Karnataka\r, India"],
    country: "India",
    created_on: "2026-09-25T06:31:29.000Z",
    job_posting: { careers: { source: "careers", from: 1790274600, to: 1798741799 } },
    is_remote: 0,
    department_name_only: "Security",
    emp_type_name: "Permanent",
    posted_on: 1790274600,
    locations: "Multiple Locations",
    title: "Application Security Engineer-2",
    ...over,
  };
}
const board = parseDarwinboxSlug("upstox")!;

describe("Darwinbox", () => {
  it("resolves a slug to the tenant host and builds the SPA's own URLs", () => {
    expect(board).toEqual({ host: "upstox.darwinbox.in", companyId: "main" });
    expect(parseDarwinboxSlug("porter.darwinbox.in")?.host).toBe("porter.darwinbox.in");
    expect(parseDarwinboxSlug("evil.com/x")).toBeNull(); // never steer the browser elsewhere
    expect(parseDarwinboxSlug("")).toBeNull();
    expect(darwinboxCareersUrl(board)).toBe("https://upstox.darwinbox.in/ms/candidatev2/main/careers/allJobs");
    expect(darwinboxJobsApiUrl(board)).toBe("https://upstox.darwinbox.in/ms/candidateapi/job/alljobs?companyId=main");
    expect(JSON.parse(darwinboxJobsBody(board, 2))).toEqual({ companyId: "main", page: 2, sort_option: "new", limit: 100 });
    expect(darwinboxJobUrl(board, "a6ab615414a427")).toBe(
      "https://upstox.darwinbox.in/ms/candidatev2/main/careers/jobDetails/a6ab615414a427",
    );
  });

  it("parses the alljobs listing into board RawPostings", () => {
    const body = JSON.stringify({ status: "success", data: [dbxJob()], job_counts: 24 });
    const page = parseDarwinboxJobs(body, board, "Upstox")!;
    expect(page.total).toBe(24);
    expect(page.pageLength).toBe(1);
    const r = page.postings[0]!;
    expect(r).toMatchObject({
      source: "darwinbox",
      tier: "tier3",
      atsType: "darwinbox",
      atsJobId: "a6ab615414a427",
      companyName: "Upstox",
      title: "Application Security Engineer-2",
      locationRaw: "Mumbai, Maharashtra, India; Bangalore, Karnataka, India",
      applyUrl: "https://upstox.darwinbox.in/ms/candidatev2/main/careers/jobDetails/a6ab615414a427",
      salaryRaw: null, // never invented
      experienceHint: { min: 3, max: 5 },
    });
    expect(r.postedAt).toBe(new Date(1790274600 * 1000).toISOString()); // posted_on (epoch s)
    expect(r.jdText).toContain("Threat modelling & code review"); // entity-decoded, tags stripped
    expect(r.jdText).not.toContain("<");

    const n = normalizePosting(r);
    expect(n.location.country).toBe("India");
    expect(n.experience).toEqual({ min: 3, max: 5 });
  });

  it("handles remote roles, stated salary and missing dates", () => {
    const body = JSON.stringify({
      status: "success",
      data: [
        dbxJob({
          id: "x1",
          is_remote: 1,
          officelocations_without_area: [],
          posted_on: null,
          job_posting: {},
          salary_currency: "INR",
          salary_min: "1800000",
          salary_max: "2600000",
          experience_from: "",
          experience_to: "",
        }),
      ],
    });
    const r = parseDarwinboxJobs(body, board, "Upstox")!.postings[0]!;
    expect(r.locationRaw).toBe("Remote - India");
    expect(r.salaryRaw).toBe("INR 1800000 - 2600000 Annual");
    expect(r.postedAt).toBe("2026-09-25T06:31:29.000Z"); // falls back to created_on
    expect(r.experienceHint).toBeUndefined();
    expect(normalizePosting(r).salary).toMatchObject({ min: 1_800_000, max: 2_600_000, currency: "INR" });
  });

  it("rejects anything that isn't the listing (bot page / error) with null", () => {
    expect(parseDarwinboxJobs("<html>Just a moment...</html>", board, "X")).toBeNull();
    expect(parseDarwinboxJobs(JSON.stringify({ status: "failure", data: [] }), board, "X")).toBeNull();
    expect(parseDarwinboxJobs("", board, "X")).toBeNull();
    // an empty board is a valid (empty) listing, not an error
    expect(parseDarwinboxJobs(JSON.stringify({ status: "success", data: [], job_counts: 0 }), board, "X")?.postings).toEqual([]);
  });

  it("the adapter POSTs from the careers page and reads every page", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init?: LocalFetchInit }> = [];
    const all = Array.from({ length: DARWINBOX_PAGE_SIZE + 3 }, (_, i) => dbxJob({ id: `j${i}` }));
    const ctx: Tier3Context = {
      enabledSources: ["darwinbox"],
      localFetch: async () => "",
      localFetchJson: async (url, _h, init) => {
        calls.push({ url, init });
        const page = JSON.parse(init!.body!).page as number;
        const data = all.slice((page - 1) * DARWINBOX_PAGE_SIZE, page * DARWINBOX_PAGE_SIZE);
        return JSON.stringify({ status: "success", data, job_counts: all.length });
      },
    };
    const p = new DarwinboxAdapter(ctx, { companyName: "Upstox" }).fetch({ slug: "upstox" });
    await vi.runAllTimersAsync();
    const jobs = await p;
    expect(jobs).toHaveLength(DARWINBOX_PAGE_SIZE + 3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init).toMatchObject({ method: "POST", landingUrl: darwinboxCareersUrl(board) });
    expect(jobs.every((j) => j.companyName === "Upstox")).toBe(true);
  });

  it("is all-or-nothing: a failed later page yields [] (never a partial board)", async () => {
    vi.useFakeTimers();
    const full = Array.from({ length: DARWINBOX_PAGE_SIZE }, (_, i) => dbxJob({ id: `j${i}` }));
    const ctx: Tier3Context = {
      enabledSources: ["darwinbox"],
      localFetch: async () => "",
      localFetchJson: async (_u, _h, init) =>
        JSON.parse(init!.body!).page === 1 ? JSON.stringify({ status: "success", data: full, job_counts: 150 }) : "",
    };
    const p = new DarwinboxAdapter(ctx).fetch({ slug: "upstox" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual([]);
  });

  it("refuses to run without the local session or the opt-in", async () => {
    await expect(new DarwinboxAdapter({ enabledSources: ["darwinbox"] }).fetch({ slug: "upstox" })).rejects.toBeInstanceOf(
      Tier3DisabledError,
    );
    await expect(
      new DarwinboxAdapter({ enabledSources: [], localFetch: async () => "" }).fetch({ slug: "upstox" }),
    ).rejects.toBeInstanceOf(Tier3DisabledError);
  });

  it("detector: a darwinbox URL yields (darwinbox, tenant) with NO network probe", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be touched");
    });
    vi.stubGlobal("fetch", fetchSpy);
    expect(atsCandidates("https://porter.darwinbox.in/ms/candidate/careers")).toEqual([{ ats: "darwinbox", slug: "porter" }]);
    expect(atsCandidates("apply: https://seclore.darwinbox.in/ms/candidate/careers/a681c7d964a6f2")[0]).toEqual({
      ats: "darwinbox",
      slug: "seclore",
    });
    expect(atsCandidates("https://cdn.darwinbox.in/x.js https://www.darwinbox.in/")).toEqual([]);
    const det = await detectFromUrl("https://rapido.darwinbox.in/ms/candidate/careers");
    expect(det).toEqual({ atsType: "darwinbox", atsSlug: "rapido", confidence: "confirmed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Peerlist ─────────────────────────────────────────────────────────────────
// `__NEXT_DATA__` → props.pageProps.jobsData, shape copied from the live /jobs page.
function peerlistHtml(jobs: unknown[], nextPage: number | null = 2): string {
  const next = { props: { pageProps: { jobsData: { jobs, page: nextPage, cursor: "CGD5O7J579" } } }, page: "/jobs" };
  return `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
}
const plJobs = [
  {
    jobId: "JOBHR8DEKGPG98GJGCEP6JEP7JBBNB",
    company: { name: "Diligent", profileHandle: "diligent", domain: "diligent.com", id: "COM1" },
    jobTitle: "Software Engineer II",
    skills: [{ name: "Java" }, { name: "Spring Boot" }],
    jobType: "Full-time",
    locationPreference: "hybrid",
    location: [{ city: "Bengaluru", country: "India", countryCode: "IN" }],
    experience: { min: 3, max: 5 },
    equity: { option: false },
    publishedAt: "2026-09-22T09:56:44.855Z",
  },
  {
    jobId: "JOBHBAR9GMJPGGBG73O9RJ777PMRAL",
    company: { name: "RapidEye", profileHandle: "rapideyeinsp" },
    jobTitle: "Senior Software Engineer - Model Platform ",
    skills: [],
    jobType: "Full-time",
    locationPreference: "remote",
    location: [{ country: "India", countryCode: "IN", preference: "remote" }],
    experience: { min: 0, max: 2 },
    salary: { currency: "INR", min: 480000, max: 780000 },
    publishedAt: "2026-09-15T21:08:35.885Z",
  },
  { jobId: "JOBX", company: { name: "Closed Co", profileHandle: "closed" }, jobTitle: "Old role", status: "CLOSED", location: [] },
  { jobId: "", jobTitle: "no id", company: { name: "X" } },
];

describe("Peerlist", () => {
  it("maps free-text queries to its role families and builds listing URLs", () => {
    expect(peerlistRoleFor("backend engineer")).toBe("backend-engineer");
    expect(peerlistRoleFor("java developer")).toBe("backend-engineer");
    expect(peerlistRoleFor("full stack developer")).toBe("full-stack-engineer");
    expect(peerlistRoleFor("sde 2")).toBe("software-engineer");
    expect(peerlistRoleFor("devops engineer")).toBe("devops");
    expect(peerlistRoleFor("")).toBeNull();
    expect(buildPeerlistUrl({ role: "backend-engineer", page: 2 })).toBe("https://peerlist.io/jobs/role/backend-engineer?page=2");
    expect(buildPeerlistUrl()).toBe("https://peerlist.io/jobs");
  });

  it("reproduces Peerlist's job-page slug (verified 100/100 against live hrefs)", () => {
    expect(peerlistTitleSlug("Senior Software Engineer - Model Platform")).toBe("senior-software-engineer--model-platform");
    expect(peerlistTitleSlug("Senior Software Engineer | Enterprise | Full-Stack")).toBe("senior-software-engineer--enterprise--fullstack");
    expect(peerlistTitleSlug("Product Designer (UI/UX)")).toBe("product-designer-uiux");
    expect(peerlistTitleSlug("Senior Software Engineer - Java ")).toBe("senior-software-engineer--java");
    expect(peerlistJobUrl("diligent", "Software Engineer II", "JOBHR8DEKGPG98GJGCEP6JEP7JBBNB")).toBe(
      "https://peerlist.io/company/diligent/careers/software-engineer-ii/jobhr8dekgpg98gjgcep6jep7jbbnb",
    );
  });

  it("parses the server-rendered page into discovery RawPostings", () => {
    const page = parsePeerlistPage(peerlistHtml(plJobs))!;
    expect(page.nextPage).toBe(2);
    expect(page.postings).toHaveLength(2); // closed + id-less dropped
    const [a, b] = page.postings as [(typeof page.postings)[0], (typeof page.postings)[0]];
    expect(a).toMatchObject({
      source: "peerlist",
      tier: "tier3",
      atsType: "unknown",
      atsJobId: "JOBHR8DEKGPG98GJGCEP6JEP7JBBNB",
      companyName: "Diligent",
      title: "Software Engineer II",
      locationRaw: "Hybrid - Bengaluru, India",
      salaryRaw: null,
      postedAt: "2026-09-22T09:56:44.855Z",
      experienceHint: { min: 3, max: 5 },
      applyUrl: "https://peerlist.io/company/diligent/careers/software-engineer-ii/jobhr8dekgpg98gjgcep6jep7jbbnb",
    });
    expect(a.jdText).toContain("Skills: Java, Spring Boot");
    expect(b.title).toBe("Senior Software Engineer - Model Platform");
    expect(b.locationRaw).toBe("Remote - India");
    expect(b.salaryRaw).toBe("INR 480000 - 780000");

    const na = normalizePosting(a);
    expect(na.location.mode).toBe("hybrid");
    expect(na.location.country).toBe("India");
    const nb = normalizePosting(b);
    expect(nb.location.mode).toBe("remote");
    expect(nb.salary).toMatchObject({ min: 480_000, max: 780_000, currency: "INR" });
  });

  it("returns null for a challenge page / non-jobs page", () => {
    expect(parsePeerlistPage("<html><title>Just a moment...</title></html>")).toBeNull();
    expect(parsePeerlistPage(peerlistHtml([], null))?.nextPage).toBeNull();
  });

  it("the adapter reads role pages through localFetch and stops at maxPages", async () => {
    const urls: string[] = [];
    const ctx: Tier3Context = {
      enabledSources: ["peerlist"],
      localFetch: async (u) => {
        urls.push(u);
        return peerlistHtml(plJobs);
      },
    };
    const jobs = await new PeerlistAdapter(ctx).fetch({ query: "backend-engineer", params: { maxPages: 1 } });
    expect(urls).toEqual(["https://peerlist.io/jobs/role/backend-engineer"]);
    expect(jobs).toHaveLength(2);
  });
});

// ── Wellfound (local path) ───────────────────────────────────────────────────
describe("Wellfound local path", () => {
  it("maps queries to role slugs", () => {
    expect(wellfoundRoleFor("backend engineer")).toBe("backend-engineer");
    expect(wellfoundRoleFor("full stack developer")).toBe("full-stack-engineer");
    expect(wellfoundRoleFor("sde 2")).toBe("software-engineer");
    expect(wellfoundRoleFor(undefined)).toBe("software-engineer");
  });

  it("reuses parseWellfoundPage through localFetch; same ids as the cloud adapter, tagged tier3", async () => {
    const apollo = {
      "StartupResult:1": { name: "Acme", highlightedJobListings: [{ __ref: "JobListingSearchResult:77" }] },
      "JobListingSearchResult:77": {
        id: "77",
        title: "Backend Engineer",
        slug: "backend-engineer",
        description: "Build APIs in Go.",
        liveStartAt: 1790000000,
        locationNames: ["Bengaluru"],
        remote: false,
        yearsExperienceMin: 2,
        yearsExperienceMax: 4,
      },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { apolloState: { data: apollo } } },
      pageCount: 1,
    })}</script>`;
    const urls: string[] = [];
    const ctx: Tier3Context = { enabledSources: ["wellfound"], localFetch: async (u) => (urls.push(u), html) };
    const jobs = await new WellfoundLocalAdapter(ctx).fetch({ query: "backend engineer", params: { maxPages: 1 } });
    expect(urls).toEqual(["https://wellfound.com/role/l/backend-engineer/india?page=1"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: "wellfound", tier: "tier3", atsJobId: "77", companyName: "Acme" });
  });
});

// ── Naukri: original post date + consultancy flag ────────────────────────────
describe("Naukri job-id date", () => {
  const NOW = Date.parse("2026-09-27T12:00:00Z");

  it("decodes DDMMYY (IST midnight) and rejects impossible dates", () => {
    expect(naukriIdDate("100726919408")?.toISOString()).toBe("2026-07-09T18:30:00.000Z"); // 10 Jul 2026 IST
    expect(naukriIdDate("310226000001")).toBeNull(); // 31 Feb
    expect(naukriIdDate("001326000001")).toBeNull(); // day 00 / month 13
    expect(naukriIdDate("99887766")).toBeNull(); // too short to carry a date
    expect(naukriIdDate("abc")).toBeNull();
  });

  it("uses the id date only when it's plausibly the original and clearly earlier", () => {
    const refreshed = "2026-09-25T10:00:00.000Z";
    // first posted 10 Jul, shown as 25 Sep → the id wins
    expect(originalPostedAt("100726919408", refreshed, NOW)).toBe("2026-07-09T18:30:00.000Z");
    // same day (IST vs UTC skew) → keep the displayed timestamp
    expect(originalPostedAt("250926919408", refreshed, NOW)).toBe(refreshed);
    // id date AFTER the displayed date → keep displayed
    expect(originalPostedAt("260926919408", "2026-09-01T00:00:00.000Z", NOW)).toBe("2026-09-01T00:00:00.000Z");
    // future id date → not a date
    expect(originalPostedAt("011226919408", refreshed, NOW)).toBe(refreshed);
    // older than a year → the pattern isn't trusted that far back
    expect(originalPostedAt("280624500630", refreshed, NOW)).toBe(refreshed);
    // nothing displayed → nothing to compare against
    expect(originalPostedAt("100726919408", null, NOW)).toBeNull();
    // an unparseable label passes through unchanged
    expect(originalPostedAt("100726919408", "Few Days Ago", NOW)).toBe("Few Days Ago");
  });

  it("reads Naukri's relative footer labels", () => {
    expect(relativeLabelIso("3 Days Ago", NOW)).toBe(new Date(NOW - 3 * 86_400_000).toISOString());
    expect(relativeLabelIso("30+ Days Ago", NOW)).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
    expect(relativeLabelIso("Just Now", NOW)).toBe(new Date(NOW).toISOString());
    expect(relativeLabelIso("Hot job", NOW)).toBeNull();
  });

  it("applies the id date + consultancy flag in the jobapi parser", () => {
    const created = Date.now() - 2 * 86_400_000; // shown as "2 days ago" (refreshed)
    const d = new Date(Date.now() - 40 * 86_400_000); // first posted ~40 days ago
    const ist = new Date(d.getTime() + 5.5 * 3_600_000);
    const ddmmyy = [ist.getUTCDate(), ist.getUTCMonth() + 1, ist.getUTCFullYear() % 100].map((n) => String(n).padStart(2, "0")).join("");
    const json = JSON.stringify({
      jobDetails: [
        { jobId: `${ddmmyy}500123`, title: "Backend Engineer", companyName: "Acme Staffing", createdDate: created, consultant: true },
        { jobId: "250926500124", title: "SDE 2", companyName: "Beta", createdDate: created, consultant: false },
        { jobId: "250926500125", title: "SDE 3", companyName: "Gamma", footerPlaceholderLabel: "1 Day Ago" },
      ],
    });
    const [a, b, c] = parseNaukriApiJson(json) as [ReturnType<typeof parseNaukriApiJson>[0], ReturnType<typeof parseNaukriApiJson>[0], ReturnType<typeof parseNaukriApiJson>[0]];
    const idStart = naukriIdDate(`${ddmmyy}500123`)!.toISOString();
    expect(a.postedAt).toBe(idStart); // refreshed listing → original date
    expect(a.raw.displayedPostedAt).toBe(new Date(created).toISOString());
    expect(a.postedByAgency).toBe(true);
    expect(b.postedByAgency).toBe(false);
    expect(c.postedByAgency).toBeUndefined(); // no flag → unknown, never guessed
    expect(typeof c.postedAt).toBe("string"); // "1 Day Ago" now becomes a date
  });

  it("consultantFlag only trusts explicit booleans", () => {
    expect(consultantFlag({ consultant: "true" })).toBe(true);
    expect(consultantFlag({ isConsultant: 1 })).toBe(true);
    expect(consultantFlag({ consultant: "N" })).toBe(false);
    expect(consultantFlag({ consultant: "maybe" })).toBeUndefined();
    expect(consultantFlag({})).toBeUndefined();
  });
});
