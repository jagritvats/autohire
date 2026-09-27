import { afterEach, describe, expect, it, vi } from "vitest";
import { isIndiaWorkable, normalizePosting, parseLocation } from "@jobflow/core";
import { AdzunaSearchAdapter, parseAdzunaResults, type AdzunaSearchResponse } from "../src/aggregators/adzuna.js";
import { CareerjetAdapter, parseCareerjetResponse, type CareerjetResponse } from "../src/aggregators/careerjet.js";
import { JSearchAdapter, parseJSearchResponse, type JSearchResponse } from "../src/aggregators/jsearch.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** a fetch stub that records calls and answers with `body` */
function stubFetch(body: unknown) {
  const fn = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ── Adzuna (shape per the published swagger: api.adzuna.com/v1/api-docs/adzuna) ──
const ADZUNA: AdzunaSearchResponse = {
  count: 3,
  results: [
    {
      id: "4810233411",
      title: "<strong>Backend</strong> Engineer - Payments",
      description: "We are looking for a <strong>backend</strong> engineer with 2+ years of Go/Java…",
      created: "2026-09-24T08:15:02Z",
      redirect_url: "https://www.adzuna.in/land/ad/4810233411?se=abc&utm_medium=api",
      company: { display_name: "Acme Fintech" },
      location: { display_name: "Bangalore, Karnataka", area: ["India", "Karnataka", "Bangalore"] },
      salary_min: 1200000,
      salary_max: 1800000,
      salary_is_predicted: "0",
      contract_type: "permanent",
      contract_time: "full_time",
      category: { tag: "it-jobs", label: "IT Jobs" },
    },
    {
      id: 4810233412,
      title: "Software Engineer",
      description: "Hybrid role in Pune.",
      created: "2026-09-25T10:00:00Z",
      redirect_url: "https://www.adzuna.in/land/ad/4810233412",
      company: { display_name: "Beta Systems" },
      location: { display_name: "India", area: ["India"] },
      salary_min: 450000,
      salary_max: 450000,
      salary_is_predicted: "1", // Adzuna's estimate — must not become a stated salary
      contract_type: "contract",
    },
    { id: "x", title: "" }, // untitled rows are dropped
  ],
};

describe("Adzuna India search", () => {
  it("maps results, strips highlight markup and names the country", () => {
    const [a, b, ...rest] = parseAdzunaResults(ADZUNA, "in");
    expect(rest).toHaveLength(0);
    expect(a).toMatchObject({
      source: "adzuna",
      tier: "tier1",
      atsJobId: "4810233411",
      companyName: "Acme Fintech",
      title: "Backend Engineer - Payments",
      locationRaw: "Bangalore, Karnataka, India",
      applyUrl: "https://www.adzuna.in/land/ad/4810233411?se=abc&utm_medium=api",
      postedAt: "2026-09-24T08:15:02Z",
      salaryRaw: "INR 1200000 - 1800000",
    });
    expect(a!.jdText).not.toContain("<strong>");
    expect(b!.locationRaw).toBe("India");
    expect(b!.atsJobId).toBe("4810233412");
    expect(b!.jdText).toContain("Contract role.");
  });

  it("keeps only STATED pay, and it parses as an INR band", () => {
    const [a, b] = parseAdzunaResults(ADZUNA, "in");
    expect(b!.salaryRaw).toBeNull(); // predicted
    const n = normalizePosting(a!);
    expect(n.salary).toMatchObject({ min: 1200000, max: 1800000, currency: "INR" });
    expect(n.location.country).toBe("India");
    expect(isIndiaWorkable(n.location)).toBe(true);
  });

  it("makes no request without ADZUNA keys", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "");
    vi.stubEnv("ADZUNA_APP_KEY", "");
    const f = stubFetch(ADZUNA);
    expect(await new AdzunaSearchAdapter().fetch({ query: "backend" })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("queries the India endpoint, newest first, with the freshness window", async () => {
    vi.stubEnv("ADZUNA_APP_ID", "id1");
    vi.stubEnv("ADZUNA_APP_KEY", "key1");
    const f = stubFetch(ADZUNA);
    const out = await new AdzunaSearchAdapter().fetch({ query: "backend", limit: 50, params: { titleOnly: true, maxDaysOld: 7 } });
    expect(out).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(1); // a short page ends pagination
    const url = new URL(String(f.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v1/api/jobs/in/search/1");
    expect(url.searchParams.get("title_only")).toBe("backend");
    expect(url.searchParams.get("what")).toBeNull();
    expect(url.searchParams.get("max_days_old")).toBe("7");
    expect(url.searchParams.get("sort_by")).toBe("date");
  });
});

// ── Careerjet (shape per the v4 partner docs: careerjet.com/partners/api) ──
const CAREERJET: CareerjetResponse = {
  type: "JOBS",
  hits: 4,
  pages: 1,
  jobs: [
    {
      title: "Backend Developer (<b>Node.js</b>)",
      company: "Gamma Labs",
      date: "Wed,23 Sep 2026 19:13:43 GMT",
      description: "Build <b>backend</b> services… 2-4 years experience",
      locations: "Bengaluru, Karnataka",
      salary: "Rs 12 lacs - 18 lacs",
      salary_currency_code: "INR",
      salary_min: 1200000,
      salary_max: 1800000,
      salary_type: "Y",
      url: "https://jobviewtrack.com/v2/abc123",
      site: "www.example-board.in",
    },
    {
      title: "Software Engineer",
      company: "Delta Tech",
      date: "Tue,22 Sep 2026 08:00:00 GMT",
      description: "Remote role",
      locations: "Remote",
      salary_currency_code: "INR",
      salary_min: 100000,
      salary_max: 150000,
      salary_type: "M", // monthly → annualised
      url: "https://jobviewtrack.com/v2/def456",
    },
    {
      title: "Java Developer",
      company: "Epsilon",
      locations: "Pune",
      salary_currency_code: "INR",
      salary_min: 500,
      salary_type: "H", // hourly — never annualised
      url: "https://jobviewtrack.com/v2/ghi789",
    },
  ],
};

describe("Careerjet (en_IN)", () => {
  it("maps jobs with a stable content id, India-named locations and the listing date", () => {
    const [a, b, c] = parseCareerjetResponse(CAREERJET, "en_IN");
    expect(a).toMatchObject({
      source: "careerjet",
      tier: "tier1",
      companyName: "Gamma Labs",
      title: "Backend Developer (Node.js)",
      locationRaw: "Bengaluru, Karnataka, India",
      applyUrl: "https://jobviewtrack.com/v2/abc123",
      postedAt: "2026-09-23T19:13:43.000Z",
      salaryRaw: "INR 1200000 - 1800000",
    });
    expect(b!.locationRaw).toBe("Remote - India");
    expect(c!.locationRaw).toBe("Pune, India");
    expect(c!.postedAt).toBeNull();
    // no source id: the same opening must key the same on every poll (idempotent upsert)
    const again = parseCareerjetResponse(structuredClone(CAREERJET), "en_IN");
    expect(again.map((r) => r.atsJobId)).toEqual([a, b, c].map((r) => r!.atsJobId));
    expect(new Set([a, b, c].map((r) => r!.atsJobId)).size).toBe(3);
  });

  it("annualises monthly pay, drops hourly, and remote parses as India-eligible", () => {
    const [, b, c] = parseCareerjetResponse(CAREERJET, "en_IN");
    expect(b!.salaryRaw).toBe("INR 1200000 - 1800000");
    expect(c!.salaryRaw).toBeNull();
    const loc = parseLocation(b!.locationRaw, b!.jdText);
    expect(loc.mode).toBe("remote");
    expect(loc.remoteGeo).toBe("india_ok");
  });

  it("returns [] in location mode (no search ran)", () => {
    expect(parseCareerjetResponse({ type: "LOCATIONS", jobs: [] } as CareerjetResponse)).toEqual([]);
    expect(parseCareerjetResponse(null)).toEqual([]);
  });

  it("is key-gated, and sends Basic auth + the mandatory user_ip/user_agent", async () => {
    vi.stubEnv("CAREERJET_API_KEY", "");
    const f = stubFetch(CAREERJET);
    expect(await new CareerjetAdapter().fetch({ query: "backend developer" })).toEqual([]);
    expect(f).not.toHaveBeenCalled();

    vi.stubEnv("CAREERJET_API_KEY", "cjkey");
    vi.stubEnv("CAREERJET_USER_IP", "203.0.113.7");
    const out = await new CareerjetAdapter().fetch({ query: "backend developer", limit: 50 });
    expect(out).toHaveLength(3);
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://search.api.careerjet.net/v4/query");
    expect(u.searchParams.get("locale_code")).toBe("en_IN");
    expect(u.searchParams.get("user_ip")).toBe("203.0.113.7");
    expect(u.searchParams.get("user_agent")).toMatch(/JobFlow/);
    expect(u.searchParams.get("sort")).toBe("date");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cjkey:").toString("base64")}`);
  });
});

// ── JSearch (shape per the vendor docs: openwebninja.com/api/jsearch/docs) ──
const JSEARCH_JOBS = [
  {
    job_id: "GrjRvpGsrjwtgFBuAAAAAA==",
    job_title: "Backend Engineer II",
    employer_name: "Zeta Payments",
    job_publisher: "LinkedIn",
    job_description: "Design and build payment APIs in Go. 2+ years experience.",
    job_apply_link: "https://in.linkedin.com/jobs/view/123",
    job_apply_is_direct: false,
    apply_options: [
      { publisher: "LinkedIn", apply_link: "https://in.linkedin.com/jobs/view/123", is_direct: false },
      { publisher: "Zeta Payments Careers", apply_link: "https://boards.greenhouse.io/zeta/jobs/987", is_direct: true },
    ],
    job_is_remote: true,
    job_posted_at_timestamp: 1790380800,
    job_posted_at_datetime_utc: "2026-09-24T00:00:00.000Z",
    job_city: "Bengaluru",
    job_state: "Karnataka",
    job_country: "IN",
    job_min_salary: 150000,
    job_max_salary: 200000,
    job_salary_currency: "INR",
    job_salary_period: "MONTH",
    job_required_experience: { required_experience_in_months: 24 },
  },
  {
    job_id: "abcDEF==",
    job_title: "Software Engineer",
    employer_name: "Omega Corp",
    job_description: "",
    job_highlights: { Qualifications: ["Java", "Spring Boot"] },
    job_apply_link: "https://www.naukri.com/job-listings-xyz",
    job_is_remote: false,
    job_posted_at_timestamp: 1790294400,
    job_city: "Pune",
    job_state: "Maharashtra",
    job_country: "IN",
    job_min_salary: 2000000,
    job_salary_period: "YEAR", // no currency → could be USD or INR: dropped
  },
];

describe("JSearch", () => {
  it("maps v1 (array) and v2 ({jobs}) responses identically", () => {
    const v1 = parseJSearchResponse({ status: "OK", data: JSEARCH_JOBS });
    const v2 = parseJSearchResponse({ status: "OK", data: { jobs: JSEARCH_JOBS, cursor: "c1" } } as JSearchResponse);
    expect(v1).toHaveLength(2);
    expect(v2.map((r) => r.atsJobId)).toEqual(v1.map((r) => r.atsJobId));
  });

  it("prefers the employer's ATS link, keeps remote geo, annualises pay, reads experience", () => {
    const [a, b] = parseJSearchResponse({ data: JSEARCH_JOBS });
    expect(a).toMatchObject({
      source: "jsearch",
      tier: "tier2",
      atsJobId: "GrjRvpGsrjwtgFBuAAAAAA==",
      companyName: "Zeta Payments",
      applyUrl: "https://boards.greenhouse.io/zeta/jobs/987",
      locationRaw: "Remote - Bengaluru, Karnataka, India",
      postedAt: "2026-09-24T00:00:00.000Z",
      salaryRaw: "INR 1800000 - 2400000",
      experienceHint: { min: 2, max: null },
    });
    const loc = parseLocation(a!.locationRaw, a!.jdText);
    expect(loc.remoteGeo).toBe("india_ok");
    expect(b!.locationRaw).toBe("Pune, Maharashtra, India");
    expect(b!.salaryRaw).toBeNull();
    expect(b!.applyUrl).toBe("https://www.naukri.com/job-listings-xyz");
    expect(b!.jdText).toContain("Spring Boot"); // highlights stand in for an empty description
    expect(b!.postedAt).toBe(new Date(1790294400 * 1000).toISOString());
  });

  it("is key-gated and calls each target at most once per JSEARCH_MIN_HOURS", async () => {
    vi.stubEnv("JSEARCH_API_KEY", "");
    vi.stubEnv("JSEARCH_RAPIDAPI_KEY", "");
    const f = stubFetch({ status: "OK", data: JSEARCH_JOBS });
    const adapter = new JSearchAdapter();
    const target = { query: "backend developer", location: "India", limit: 50, params: { country: "in", datePosted: "week" } };
    expect(await adapter.fetch(target)).toEqual([]);
    expect(f).not.toHaveBeenCalled();

    vi.stubEnv("JSEARCH_RAPIDAPI_KEY", "rk");
    expect(await adapter.fetch(target)).toHaveLength(2);
    expect(await adapter.fetch(target)).toEqual([]); // within the spend window
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.host).toBe("jsearch.p.rapidapi.com");
    expect(u.searchParams.get("query")).toBe("backend developer in India");
    expect(u.searchParams.get("country")).toBe("in");
    expect(u.searchParams.get("num_pages")).toBe("5");
    expect((init?.headers as Record<string, string>)["X-RapidAPI-Key"]).toBe("rk");

    vi.stubEnv("JSEARCH_MIN_HOURS", "0");
    await adapter.fetch(target);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
