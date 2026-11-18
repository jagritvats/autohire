import { afterEach, describe, expect, it, vi } from "vitest";
import { atsCandidates } from "../src/detector/index.js";
import { RecruiteeAdapter, parseRecruiteeOffers, recruiteeDate, type RecruiteeOffer } from "../src/ats/recruitee.js";
import { PersonioAdapter, parsePersonioXml, personioHost, personioYears } from "../src/ats/personio.js";
import { TeamtailorAdapter, parseTeamtailorRss, teamtailorHost } from "../src/ats/teamtailor.js";
import { BambooHrAdapter, parseBambooJobs } from "../src/ats/bamboohr.js";
import { BreezyAdapter, breezyGoneRedirect, parseBreezyPositions } from "../src/ats/breezy.js";
import { RemoteOkAdapter, parseRemoteOk } from "../src/aggregators/remoteok.js";
import { JobicyAdapter, parseJobicyJobs } from "../src/aggregators/jobicy.js";
import { cloudAdapter } from "../src/registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** a fetch stub answering by URL; records every call */
function stub(route: Route) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => route(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

// ── Recruitee ────────────────────────────────────────────────────────────────
const RECRUITEE: RecruiteeOffer[] = [
  {
    id: 101,
    slug: "backend-engineer",
    title: "Backend Engineer",
    status: "published",
    company_name: "Example Corp",
    description: "<p>Build <b>APIs</b> in Go.</p>",
    requirements: "<ul><li>3+ years of Go</li></ul>",
    careers_url: "https://jobs.example.com/o/backend-engineer",
    published_at: "2026-11-03 20:08:14 UTC",
    created_at: "2026-10-01 09:00:00 UTC",
    remote: false,
    hybrid: true,
    locations: [{ city: "Utrecht", state: "Utrecht", country: "Netherlands" }],
    salary: { min: "4000", max: "5500", currency: "EUR", period: "month" },
    experience_code: "entry_level",
  },
  { id: 101, title: "Backend Engineer", status: "published" }, // repeated row
  { id: 102, title: "Old role", status: "closed" },
  { id: 103, title: "Remote SRE", status: "published", remote: true, locations: [], location: "", salary: { min: null, max: null, currency: null, period: null } },
];

describe("Recruitee offers", () => {
  it("maps fields, merges JD sections, skips closed + repeated offers", () => {
    const raws = parseRecruiteeOffers(RECRUITEE, "example");
    expect(raws.map((r) => r.atsJobId)).toEqual(["101", "103"]);
    const r = raws[0]!;
    expect(r).toMatchObject({
      source: "recruitee",
      atsType: "recruitee",
      companyName: "Example Corp",
      title: "Backend Engineer",
      locationRaw: "Hybrid - Utrecht, Utrecht, Netherlands",
      applyUrl: "https://jobs.example.com/o/backend-engineer",
      salaryRaw: "EUR 4000 - 5500 per month",
      postedAt: "2026-11-03T20:08:14.000Z",
      levelHint: "junior",
    });
    expect(r.jdText).toContain("APIs");
    expect(r.jdText).toContain("3+ years of Go");
    expect(raws[1]).toMatchObject({ locationRaw: "Remote", salaryRaw: null, applyUrl: null });
    expect(recruiteeDate("garbage")).toBeNull();
  });

  it("fetch: [] on a 404 board; isLive false on a per-offer 404 or a closed status, null on 5xx", async () => {
    stub(() => text("Not found", 404));
    expect(await new RecruiteeAdapter().fetch({ slug: "nope" })).toEqual([]);
    const a = new RecruiteeAdapter();
    stub(() => text("{}", 404));
    expect(await a.isLive({ slug: "example", jobId: "1", applyUrl: null })).toBe(false);
    stub(() => json({ offer: { status: "closed" } }));
    expect(await a.isLive({ slug: "example", jobId: "1", applyUrl: null })).toBe(false);
    stub(() => json({ offer: { status: "published" } }));
    expect(await a.isLive({ slug: "example", jobId: "1", applyUrl: null })).toBe(true);
    stub(() => text("oops", 503));
    expect(await a.isLive({ slug: "example", jobId: "1", applyUrl: null })).toBeNull();
  });
});

// ── Personio ─────────────────────────────────────────────────────────────────
const PERSONIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2502124</id>
    <subcompany>Example GmbH</subcompany>
    <office>Munich</office>
    <additionalOffices>
        <office>Remote</office>
        <office>Hamburg</office>
    </additionalOffices>
    <department>Engineering</department>
    <recruitingCategory>Tech &amp; Product</recruitingCategory>
    <name>Backend Engineer (m/f/d)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Your tasks</name>
            <value><![CDATA[<ul><li>Build services in Kotlin</li></ul>]]></value>
        </jobDescription>
        <jobDescription>
            <name>Your profile</name>
            <value><![CDATA[<p>2+ years backend</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>entry-level</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>2-5</yearsOfExperience>
    <keywords>Kotlin, PostgreSQL</keywords>
    <createdAt>2026-01-22T09:48:25+00:00</createdAt>
    <salaryInformation>
        <min>60000.00</min>
        <max>75000.00</max>
        <currencySymbol>€</currencySymbol>
        <currencyCode>EUR</currencyCode>
        <type>yearly</type>
    </salaryInformation>
</position>
<position>
    <id>2840027</id>
    <subcompany></subcompany>
    <office>Berlin</office>
    <name>Working Student Data</name>
    <jobDescriptions></jobDescriptions>
    <employmentType>working_student</employmentType>
    <seniority>student</seniority>
    <yearsOfExperience>lt-1</yearsOfExperience>
    <createdAt>2026-11-01T10:00:00+01:00</createdAt>
</position>
</workzag-jobs>`;

describe("Personio XML feed", () => {
  it("reads the position (not the JD sections' <name>s), offices, salary and experience", () => {
    const [p, q] = parsePersonioXml(PERSONIO_XML);
    expect(p).toMatchObject({ id: "2502124", name: "Backend Engineer (m/f/d)", subcompany: "Example GmbH", additionalOffices: ["Remote", "Hamburg"] });
    expect(p!.sections.map((s) => s.name)).toEqual(["Your tasks", "Your profile"]);
    expect(p!.salary).toEqual({ min: "60000.00", max: "75000.00", currency: "EUR", type: "yearly" });
    expect(q).toMatchObject({ id: "2840027", name: "Working Student Data", sections: [], salary: null });
    expect(personioYears("2-5")).toEqual({ min: 2, max: 5 });
    expect(personioYears("lt-1")).toEqual({ min: 0, max: 1 });
    expect(personioYears("")).toBeUndefined();
  });

  it("fetch maps to RawPostings; host normalisation; [] for a non-feed answer", async () => {
    expect(personioHost("example")).toBe("example.jobs.personio.de");
    expect(personioHost("https://example.jobs.personio.com/")).toBe("example.jobs.personio.com");
    expect(personioHost("bad slug")).toBeNull();
    const calls = stub(() => text(PERSONIO_XML));
    const raws = await new PersonioAdapter().fetch({ slug: "example" });
    expect(calls.mock.calls[0]![0]).toBe("https://example.jobs.personio.de/xml");
    expect(raws).toHaveLength(2);
    expect(raws[0]).toMatchObject({
      source: "personio",
      atsJobId: "2502124",
      companyName: "Example GmbH",
      locationRaw: "Remote - Munich; Hamburg",
      applyUrl: "https://example.jobs.personio.de/job/2502124",
      salaryRaw: "EUR 60000 - 75000 yearly",
      postedAt: "2026-01-22T09:48:25.000Z",
      levelHint: "junior",
      experienceHint: { min: 2, max: 5 },
    });
    expect(raws[0]!.jdText).toContain("Build services in Kotlin");
    expect(raws[1]).toMatchObject({ companyName: "example", levelHint: "intern", locationRaw: "Berlin" });
    stub(() => text("<html>not found</html>", 404));
    expect(await new PersonioAdapter().fetch({ slug: "example" })).toEqual([]);
  });
});

// ── Teamtailor ───────────────────────────────────────────────────────────────
const TT_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>Example AB</title>
    <link>https://example.teamtailor.com/jobs</link>
    <item>
      <title>Platform Engineer</title>
      <description>&lt;p&gt;Run &lt;strong&gt;Kubernetes&lt;/strong&gt; at scale.&lt;/p&gt;</description>
      <pubDate>Mon, 09 Nov 2026 11:03:21 +0100</pubDate>
      <link>https://jobs.example.com/jobs/8688378-platform-engineer</link>
      <remoteStatus>hybrid</remoteStatus>
      <guid>474f722a-396e-4f6d-bba3-1ae14e33154d</guid>
      <tt:locations>
        <tt:location><tt:name>Stockholm, Sweden</tt:name><tt:city>Stockholm</tt:city><tt:country>Sweden</tt:country></tt:location>
        <tt:location><tt:name>Copenhagen, Denmark</tt:name><tt:city>København</tt:city><tt:country>Denmark</tt:country></tt:location>
      </tt:locations>
      <tt:department>Infra</tt:department>
    </item>
    <item>
      <title>Remote Data Engineer</title>
      <description>&lt;p&gt;Pipelines.&lt;/p&gt;</description>
      <pubDate>Sun, 08 Nov 2026 21:52:50 +0100</pubDate>
      <link>https://example.teamtailor.com/jobs/8685705-remote-data-engineer</link>
      <remoteStatus>fully</remoteStatus>
      <guid>0382c641-dd88-443b-b63d-5cce74b904b9</guid>
      <tt:locations/>
    </item>
  </channel>
</rss>`;

describe("Teamtailor RSS", () => {
  it("parses items with tt:locations and remoteStatus; ids from the job link", async () => {
    expect(parseTeamtailorRss(TT_RSS)).toHaveLength(2);
    stub(() => text(TT_RSS));
    const raws = await new TeamtailorAdapter().fetch({ slug: "example" });
    expect(raws.map((r) => r.atsJobId)).toEqual(["8688378", "8685705"]);
    expect(raws[0]).toMatchObject({
      source: "teamtailor",
      atsType: "teamtailor",
      companyName: "Example AB",
      companySlug: "example",
      locationRaw: "Hybrid - Stockholm, Sweden; Copenhagen, Denmark",
      applyUrl: "https://jobs.example.com/jobs/8688378-platform-engineer",
      postedAt: "2026-11-09T10:03:21.000Z",
    });
    expect(raws[0]!.jdText).toBe("Run Kubernetes at scale.");
    expect(raws[1]!.locationRaw).toBe("Remote");
  });

  it("custom domains are their own host; isLive follows the 301 and reads a 404", async () => {
    expect(teamtailorHost("example")).toBe("example.teamtailor.com");
    expect(teamtailorHost("https://jobs.example.com/jobs")).toBe("jobs.example.com");
    const calls = stub(() => text("gone", 404));
    expect(await new TeamtailorAdapter().isLive({ slug: "example", jobId: "8688378", applyUrl: null })).toBe(false);
    expect(calls.mock.calls[0]![1]).toMatchObject({ redirect: "follow" });
    stub(() => text("<html></html>", 200));
    expect(await new TeamtailorAdapter().isLive({ slug: "example", jobId: "8688378", applyUrl: null })).toBe(true);
    stub(() => text("<html>404</html>", 404));
    expect(await new TeamtailorAdapter().fetch({ slug: "nope" })).toEqual([]);
  });
});

// ── BambooHR ─────────────────────────────────────────────────────────────────
describe("BambooHR careers JSON", () => {
  const LIST = {
    meta: { totalCount: 3 },
    result: [
      { id: "351", jobOpeningName: "Software Engineer", departmentLabel: "Eng", location: { city: "Lehi", state: "Utah" }, atsLocation: { country: null }, isRemote: null, locationType: "2" },
      { id: "352", jobOpeningName: "Sales Lead", location: { city: "Austin", state: "Texas" }, locationType: "0" },
      { id: "353", jobOpeningName: "Closed Role", location: { city: "Lehi", state: "Utah" }, locationType: "1" },
    ],
  };
  const detail = (id: string, status = "Open") => ({
    result: {
      jobOpening: {
        jobOpeningShareUrl: `https://example.bamboohr.com/careers/${id}`,
        jobOpeningStatus: status,
        description: "<p>Write TypeScript.</p>",
        datePosted: "2026-08-18",
        minimumExperience: "Entry-level",
        compensation: "$90k-$110k",
        location: { city: "Lehi", state: "Utah", addressCountry: "United States" },
        locationType: "2",
      },
    },
  });

  it("lists, fetches details for new openings only, drops a detail that says closed", async () => {
    const calls = stub((url) => {
      if (url.endsWith("/careers/list")) return json(LIST);
      const id = url.match(/careers\/(\d+)\/detail/)![1]!;
      return json(detail(id, id === "353" ? "Closed" : "Open"));
    });
    const raws = await new BambooHrAdapter().fetch({ slug: "example", known: new Set(["352"]) });
    expect(calls.mock.calls.map((c) => c[0])).not.toContain("https://example.bamboohr.com/careers/352/detail");
    expect(raws.map((r) => r.atsJobId)).toEqual(["351", "352"]);
    expect(raws[0]).toMatchObject({
      source: "bamboohr",
      tier: "tier2",
      locationRaw: "Hybrid - Lehi, Utah, United States",
      applyUrl: "https://example.bamboohr.com/careers/351",
      postedAt: "2026-08-18T00:00:00.000Z",
      salaryRaw: "$90k-$110k",
      levelHint: "junior",
    });
    expect(raws[0]!.jdText).toContain("Write TypeScript.");
    // the known one is a lite row (no JD) — ingest keeps the stored JD
    expect(raws[1]).toMatchObject({ jdText: "", locationRaw: "Austin, Texas", applyUrl: "https://example.bamboohr.com/careers/352" });
  });

  it("an unknown tenant (302 → bamboohr.com) is []; isLive: 404 → false, Closed → false", async () => {
    stub(() => new Response(null, { status: 302, headers: { location: "https://www.bamboohr.com" } }));
    expect(await new BambooHrAdapter().fetch({ slug: "nope" })).toEqual([]);
    stub(() => json({ type: "not_found" }, 404));
    expect(await new BambooHrAdapter().isLive({ slug: "example", jobId: "9", applyUrl: null })).toBe(false);
    stub(() => json(detail("9", "Closed")));
    expect(await new BambooHrAdapter().isLive({ slug: "example", jobId: "9", applyUrl: null })).toBe(false);
    stub(() => json(detail("9")));
    expect(await new BambooHrAdapter().isLive({ slug: "example", jobId: "9", applyUrl: null })).toBe(true);
    expect(parseBambooJobs([], new Map(), "example")).toEqual([]);
  });
});

// ── Breezy ───────────────────────────────────────────────────────────────────
describe("Breezy HR portal", () => {
  const LIST = [
    {
      id: "c456311e9238",
      friendly_id: "c456311e9238-backend-engineer",
      name: "Backend Engineer",
      url: "https://example.breezy.hr/p/c456311e9238-backend-engineer",
      published_date: "2026-11-17T19:38:36.787Z",
      location: { city: "Moscow", state: { id: "ID", name: "Idaho" }, country: { id: "US", name: "United States" }, is_remote: false, name: "Moscow, ID" },
      salary: "$120,000 – $150,000 / year",
      company: { name: "Example Inc" },
    },
    { id: "aaa111bbb222", name: "Remote Support", location: { is_remote: true, name: "Remote" }, locations: [{ is_remote: true, name: "Remote", country: { name: "Canada" } }] },
  ];
  const PAGE = `<html><script type="application/ld+json">{"@type":"WebSite","name":"Breezy HR"}</script>
    <script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Backend Engineer","description":"<p>Ship Rust services.</p>","datePosted":"2026-11-13"}</script></html>`;

  it("lists positions, reads the JD from the job page's JobPosting JSON-LD", async () => {
    stub((url) => (url.endsWith("/json") ? json(LIST) : text(PAGE)));
    const raws = await new BreezyAdapter().fetch({ slug: "example" });
    expect(raws[0]).toMatchObject({
      source: "breezy",
      atsJobId: "c456311e9238",
      companyName: "Example Inc",
      locationRaw: "Moscow, Idaho, United States",
      salaryRaw: "$120,000 – $150,000 / year",
      postedAt: "2026-11-17T19:38:36.787Z",
      applyUrl: "https://example.breezy.hr/p/c456311e9238-backend-engineer",
    });
    expect(raws[0]!.jdText).toBe("Ship Rust services.");
    expect(raws[1]).toMatchObject({ locationRaw: "Remote - Canada", companyName: "example" });
    expect(parseBreezyPositions([{ id: "", name: "x" }], new Map(), "example")).toEqual([]);
  });

  it("isLive: 200 live; a 302 to the portal root = gone; any other redirect = can't tell", async () => {
    expect(breezyGoneRedirect("https://example.breezy.hr/", "example")).toBe(true);
    expect(breezyGoneRedirect("/", "example")).toBe(true);
    expect(breezyGoneRedirect("https://example.breezy.hr/p/other", "example")).toBe(false);
    const a = new BreezyAdapter();
    stub(() => new Response(null, { status: 302, headers: { location: "https://example.breezy.hr/" } }));
    expect(await a.isLive({ slug: "example", jobId: "c456311e9238", applyUrl: null })).toBe(false);
    stub(() => new Response(null, { status: 302, headers: { location: "https://login.example.com/" } }));
    expect(await a.isLive({ slug: "example", jobId: "c456311e9238", applyUrl: null })).toBeNull();
    stub(() => text("<html></html>"));
    expect(await a.isLive({ slug: "example", jobId: "c456311e9238", applyUrl: null })).toBe(true);
    stub(() => text("<html>not found</html>", 404));
    expect(await a.fetch({ slug: "nope" })).toEqual([]);
  });
});

// ── Remote OK / Jobicy ───────────────────────────────────────────────────────
describe("Remote OK API", () => {
  const ROWS = [
    { last_updated: 1794873629, legal: "API Terms of Service: Please link back…" },
    { id: "1137799", slug: "remote-python-engineer-example-1137799", date: "2026-11-17T00:00:29+00:00", company: "Example Co", position: "Senior Python Engineer", tags: ["python", "backend"], description: "<p>Django.</p>", location: "Europe", salary_min: 90000, salary_max: 120000, url: "https://remoteOK.com/remote-jobs/remote-python-engineer-example-1137799", apply_url: "https://example.com/apply" },
    { id: "1137800", slug: "x", date: "2026-11-16T00:00:00+00:00", company: "Other Co", position: "Designer", tags: ["design"], location: "", salary_min: 0, salary_max: 0, url: "https://remoteOK.com/remote-jobs/x" },
  ];

  it("skips the terms row, links back to Remote OK (ToS), filters client-side by the query", () => {
    const all = parseRemoteOk(ROWS);
    expect(all.map((r) => r.atsJobId)).toEqual(["1137799", "1137800"]);
    expect(all[0]).toMatchObject({
      source: "remoteok",
      atsType: "unknown",
      applyUrl: "https://remoteOK.com/remote-jobs/remote-python-engineer-example-1137799",
      locationRaw: "Remote - Europe",
      salaryRaw: "USD 90000 - 120000 per year",
      postedAt: "2026-11-17T00:00:29.000Z",
    });
    expect(all[1]).toMatchObject({ locationRaw: "Remote", salaryRaw: null });
    expect(parseRemoteOk(ROWS, "python").map((r) => r.atsJobId)).toEqual(["1137799"]);
  });

  it("asks for the tag, and [] on an error", async () => {
    const calls = stub(() => json(ROWS));
    expect(await new RemoteOkAdapter().fetch({ query: "python", limit: 10 })).toHaveLength(1);
    expect(calls.mock.calls[0]![0]).toBe("https://remoteok.com/api?tag=python");
    stub(() => text("rate limited", 429));
    expect(await new RemoteOkAdapter().fetch({})).toEqual([]);
  });
});

describe("Jobicy API", () => {
  const page = (ids: number[], nextCursor: string | null) => ({
    jobs: ids.map((id) => ({
      id,
      url: `https://jobicy.com/jobs/${id}-backend-engineer`,
      jobTitle: "Backend Engineer &amp; SRE",
      companyName: "Example Co",
      jobGeo: "LATAM,  Canada,  USA",
      jobLevel: "Senior",
      jobDescription: "<p>Go and Postgres.</p>",
      pubDate: "2026-11-18T04:45:05+00:00",
      salaryMin: "30000",
      salaryMax: "35000",
      salaryCurrency: "USD",
      salaryPeriod: "yearly",
    })),
    nextCursor,
    hasMore: !!nextCursor,
  });

  it("pages by cursor up to the limit, maps geo/level/salary, links to Jobicy (ToS)", async () => {
    const calls = stub((url) => (url.includes("cursor=") ? json(page([3, 4], null)) : json(page([1, 2], "abc"))));
    const raws = await new JobicyAdapter().fetch({ query: "backend", limit: 3, params: { geo: "usa", industry: "engineering" } });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(String(calls.mock.calls[0]![0])).toContain("tag=backend");
    expect(String(calls.mock.calls[0]![0])).toContain("geo=usa");
    expect(String(calls.mock.calls[1]![0])).toContain("cursor=abc");
    expect(raws.map((r) => r.atsJobId)).toEqual(["1", "2", "3"]);
    expect(raws[0]).toMatchObject({
      source: "jobicy",
      title: "Backend Engineer & SRE",
      locationRaw: "Remote - LATAM, Canada, USA",
      applyUrl: "https://jobicy.com/jobs/1-backend-engineer",
      salaryRaw: "USD 30000 - 35000 per year",
      levelHint: "senior",
    });
    expect(parseJobicyJobs([{ id: 9, jobTitle: "x", companyName: "y", jobGeo: "Anywhere" }])[0]!.locationRaw).toBe("Remote - Worldwide");
  });

  it("isLive: only an explicit 'closed' retires; 'unknown' or an error can't tell", async () => {
    const a = new JobicyAdapter();
    const status = (s: string) => json({ jobs: [{ id: 155536, status: s }] });
    stub(() => status("closed"));
    expect(await a.isLive({ slug: null, jobId: "155536", applyUrl: null })).toBe(false);
    stub(() => status("active"));
    expect(await a.isLive({ slug: null, jobId: "155536", applyUrl: null })).toBe(true);
    stub(() => status("unknown"));
    expect(await a.isLive({ slug: null, jobId: "155536", applyUrl: null })).toBeNull();
    stub(() => text("", 429));
    expect(await a.isLive({ slug: null, jobId: "155536", applyUrl: null })).toBeNull();
  });
});

describe("detector: new ATS URL forms", () => {
  it("recognises Recruitee, Personio, Teamtailor, BambooHR and Breezy boards", () => {
    expect(atsCandidates("https://example.recruitee.com/o/backend")[0]).toEqual({ ats: "recruitee", slug: "example" });
    expect(atsCandidates("https://example.jobs.personio.de/job/123")[0]).toEqual({ ats: "personio", slug: "example" });
    expect(atsCandidates("https://example.teamtailor.com/jobs")[0]).toEqual({ ats: "teamtailor", slug: "example" });
    expect(atsCandidates("https://example.bamboohr.com/careers/12")[0]).toEqual({ ats: "bamboohr", slug: "example" });
    expect(atsCandidates("https://example.breezy.hr/p/abc")[0]).toEqual({ ats: "breezy", slug: "example" });
  });

  it("skips platform hosts, and reads a custom-domain Teamtailor site from its CDN assets", () => {
    expect(atsCandidates('<script src="https://assets-aws.teamtailor-cdn.com/x.js"></script>')).toEqual([]);
    expect(atsCandidates("https://www.bamboohr.com/pricing https://app.breezy.hr/signin")).toEqual([]);
    const html = '<link href="https://assets-aws.teamtailor-cdn.com/assets/careersite.css">';
    expect(atsCandidates(html, "https://jobs.example.com/jobs")).toEqual([{ ats: "teamtailor", slug: "jobs.example.com" }]);
  });

  it("every new ATS has a cloud poller", () => {
    for (const ats of ["recruitee", "personio", "teamtailor", "bamboohr", "breezy", "remoteok", "jobicy"]) {
      expect(cloudAdapter(ats)?.source).toBe(ats);
    }
  });
});
