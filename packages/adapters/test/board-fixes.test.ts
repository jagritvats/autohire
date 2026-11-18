import { afterEach, describe, expect, it, vi } from "vitest";
import { isPartialFetch, httpJsonPolite } from "../src/types.js";
import { WorkableAdapter, parseWorkableJobs, workablePosted } from "../src/ats/workable.js";
import { AmazonJobsAdapter } from "../src/ats/amazon.js";
import { EightfoldAdapter } from "../src/ats/eightfold.js";
import { SmartRecruitersAdapter } from "../src/ats/smartrecruiters.js";
import { HiristAdapter } from "../src/india/hirist.js";
import { ArbeitnowAdapter } from "../src/aggregators/arbeitnow.js";

/** Regression tests for the 2026-11 source health audit (docs/internal/SOURCE_HEALTH.md). */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(route: Route) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => route(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe("Workable widget (location is top-level; one row per city)", () => {
  const ROWS = [
    { title: "Java Tech Lead", shortcode: "724B311060", url: "https://apply.workable.com/j/724B311060", published_on: "2026-11-10", created_at: "2026-11-01", country: "Portugal", city: "Porto", state: "", locations: [{ country: "Portugal", countryCode: "PT", city: "Porto", region: null, hidden: false }], description: "<p>Java</p>", experience: "Mid-Senior level" },
    { title: "Java Tech Lead", shortcode: "724B311060", url: "https://apply.workable.com/j/724B311060", published_on: "2026-11-10", created_at: "2026-11-01", country: "India", city: "Bengaluru", state: "Karnataka", locations: [{ country: "India", countryCode: "IN", city: "Bengaluru", region: "Karnataka", hidden: false }] },
    { title: "General Pipeline", shortcode: "E4DA01E9D9", telecommuting: true, published_on: "2026-11-16", created_at: "2025-07-08", country: "Morocco", city: "Casablanca", state: "Casablanca-Settat", experience: "Entry level" },
  ];

  it("folds rows by shortcode with every city; reads the top-level place", () => {
    const raws = parseWorkableJobs(ROWS, "example", "Example");
    expect(raws.map((r) => r.atsJobId)).toEqual(["724B311060", "E4DA01E9D9"]);
    expect(raws[0]).toMatchObject({ companyName: "Example", locationRaw: "Porto, Portugal; Bengaluru, Karnataka, India", postedAt: "2026-11-10T00:00:00.000Z", levelHint: null });
    expect(raws[0]!.jdText).toBe("Java");
    // a re-publish long after creation keeps the creation date
    expect(raws[1]).toMatchObject({ locationRaw: "Remote - Casablanca, Casablanca-Settat, Morocco", postedAt: "2025-07-08T00:00:00.000Z", levelHint: "junior" });
    expect(workablePosted("2026-11-10", "2026-11-01")).toBe("2026-11-10T00:00:00.000Z");
  });

  it("[] on a rate-limited answer", async () => {
    stub(() => text("error code: 1015", 429, { "retry-after": "84036" }));
    expect(await new WorkableAdapter().fetch({ slug: "example" })).toEqual([]);
  });
});

describe("truncated board lists are marked partial (invariant #5)", () => {
  it("Amazon: the 500-row window of a bigger board is partial and deduped across shifting pages", async () => {
    stub((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      // page 2 repeats the last row of page 1 (a new req shifted the list)
      const ids = Array.from({ length: 100 }, (_, i) => offset + i - (offset ? 1 : 0));
      return json({ hits: 900, jobs: ids.map((id) => ({ id_icims: String(id), title: `Engineer ${id}`, posted_date: "November 1, 2026" })) });
    });
    const raws = await new AmazonJobsAdapter().fetch({ slug: "amazon", location: "IN" });
    expect(new Set(raws.map((r) => r.atsJobId)).size).toBe(raws.length);
    expect(isPartialFetch(raws)).toBe(true);

    stub(() => json({ hits: 2, jobs: [{ id_icims: "1", title: "A" }, { id_icims: "2", title: "B" }] }));
    expect(isPartialFetch(await new AmazonJobsAdapter().fetch({ slug: "amazon" }))).toBe(false);
  });

  it("Eightfold: dedupes repeated rows, marks a list cut at 200 partial, a complete one not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    stub((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/position_details")) return json({ data: { jobDescription: "<p>JD</p>" } });
      const start = Number(u.searchParams.get("start"));
      const ids = Array.from({ length: 10 }, (_, i) => start + i - (start ? 1 : 0));
      return json({ data: { count: 500, positions: ids.map((id) => ({ id, name: `Eng ${id}`, locations: ["Bengaluru"] })) } });
    });
    const run = new EightfoldAdapter().fetch({ slug: "careers.example.com/example.com", location: "IN", limit: 1 });
    await vi.runAllTimersAsync();
    const raws = await run;
    expect(new Set(raws.map((r) => r.atsJobId)).size).toBe(raws.length);
    expect(isPartialFetch(raws)).toBe(true);

    stub((url) =>
      new URL(url).pathname.endsWith("/position_details")
        ? json({ data: {} })
        : json({ data: { count: 2, positions: [{ id: 1, name: "A" }, { id: 2, name: "B" }] } }),
    );
    const run2 = new EightfoldAdapter().fetch({ slug: "careers.example.com/example.com", known: new Set(["1", "2"]) });
    await vi.runAllTimersAsync();
    expect(isPartialFetch(await run2)).toBe(false);
  });

  it("Eightfold: waits out a 429 burst instead of losing the whole list", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    stub(() => (++n <= 2 ? text("", 429) : json({ data: { count: 1, positions: [{ id: 7, name: "Eng" }] } })));
    const run = new EightfoldAdapter().fetch({ slug: "careers.example.com/example.com", known: new Set(["7"]) });
    await vi.runAllTimersAsync();
    expect((await run).map((r) => r.atsJobId)).toEqual(["7"]);
  });

  it("SmartRecruiters: a list cut at 600 is partial", async () => {
    stub((url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset"));
      const content = Array.from({ length: 100 }, (_, i) => ({ id: String(offset + i), name: `Sales ${offset + i}` }));
      return json({ totalFound: 800, content });
    });
    const raws = await new SmartRecruitersAdapter().fetch({ slug: "Example", limit: 0 });
    expect(raws).toHaveLength(600);
    expect(isPartialFetch(raws)).toBe(true);
  });
});

describe("feed pagination fixes", () => {
  it("Hirist: overlapping relevance pages are deduped and paging continues to the limit", async () => {
    stub((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const ids = Array.from({ length: 20 }, (_, i) => page * 15 + i); // 5-row overlap between pages
      return json({ hasMore: true, data: ids.map((id) => ({ id, title: `Backend Developer ${id}`, companyData: { companyName: "Example" } })) });
    });
    const raws = await new HiristAdapter().fetch({ query: "backend", limit: 40 });
    expect(raws).toHaveLength(40);
    expect(new Set(raws.map((r) => r.atsJobId)).size).toBe(40);
  });

  it("Arbeitnow: a query walks pages until the limit (the API has no search)", async () => {
    const calls = stub((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const data = Array.from({ length: 300 }, (_, i) => ({ slug: `job-${page}-${i}`, company_name: "Example GmbH", title: i % 100 === 0 ? "Backend Engineer" : "Vertrieb", location: "" }));
      return json({ data, links: { next: page < 5 ? `https://www.arbeitnow.com/api/job-board-api?page=${page + 1}` : null } });
    });
    const raws = await new ArbeitnowAdapter().fetch({ query: "engineer", limit: 6 });
    expect(raws).toHaveLength(6);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(raws[0]!.locationRaw).toBeNull(); // "" is no location
    stub(() => text("down", 500));
    expect(await new ArbeitnowAdapter().fetch({ query: "engineer" })).toEqual([]);
  });
});

describe("httpJsonPolite", () => {
  it("retries a 429 honouring Retry-After, gives up beyond the cap, never retries a 404", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let n = 0;
    stub(() => (++n === 1 ? text("", 429, { "retry-after": "3" }) : json({ ok: true })));
    expect(await httpJsonPolite("https://x.example/a", {}, { sleep })).toEqual({ ok: true });
    expect(sleeps).toEqual([3000]);

    sleeps.length = 0;
    stub(() => text("", 429, { "retry-after": "84036" }));
    expect(await httpJsonPolite("https://x.example/a", {}, { sleep })).toBeNull();
    expect(sleeps).toEqual([]);

    const calls = stub(() => text("", 404));
    expect(await httpJsonPolite("https://x.example/a", {}, { sleep })).toBeNull();
    expect(calls).toHaveBeenCalledTimes(1);

    sleeps.length = 0;
    stub(() => text("", 503));
    expect(await httpJsonPolite("https://x.example/a", {}, { sleep, retries: 2, baseDelayMs: 100 })).toBeNull();
    expect(sleeps).toEqual([100, 200]);
  });
});
