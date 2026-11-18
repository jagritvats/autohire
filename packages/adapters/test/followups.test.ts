import { afterEach, describe, expect, it, vi } from "vitest";
import { isPartialFetch } from "../src/types.js";
import { WorkdayAdapter, splitRedacted } from "../src/ats/workday.js";
import { GreenhouseAdapter, greenhouseLocation } from "../src/ats/greenhouse.js";
import { EightfoldAdapter } from "../src/ats/eightfold.js";
import { HimalayasAdapter, resetHimalayasPause } from "../src/aggregators/himalayas.js";
import { JobicyAdapter, JOBICY_MIN_INTERVAL_MS, resetJobicyPacing } from "../src/aggregators/jobicy.js";
import { httpJsonPolite } from "../src/types.js";

/** Regression tests for the follow-ups to the 2026-11 source and preset audits. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

describe("Workday: redacted rows (no title / externalPath) are skipped, not fatal", () => {
  const SLUG = "acme.wd1.myworkdayjobs.com/acme/External";
  const facets = [{ facetParameter: "Location_Country", values: [{ descriptor: "India", id: "c-in" }] }];
  const row = (n: number) => ({ title: `Software Engineer ${n}`, externalPath: `/job/Pune/Software-Engineer_R-${n}`, locationsText: "Pune", postedOn: "Posted Today", bulletFields: [`R-${n}`] });
  const listRoute = (pages: unknown[][], total: number): Route => (url, init) => {
    if (!url.endsWith("/jobs")) return json({ jobPostingInfo: { jobDescription: "<p>Go</p>" } });
    const offset = (JSON.parse(String(init?.body)) as { offset: number }).offset;
    return json({ total, facets, jobPostings: pages[offset / 20] ?? [] });
  };
  const fullPage = Array.from({ length: 19 }, (_, i) => row(i + 1));

  it("splitRedacted keeps identified rows and spots a redacted row we already store", () => {
    const jobs = [row(1), { bulletFields: ["R-77"] }, { title: "  ", externalPath: "/job/x/y_R-78" }];
    const s = splitRedacted(jobs);
    expect(s.rows.map((r) => r.title)).toEqual(["Software Engineer 1"]);
    expect(s.redacted).toBe(2);
    expect(s.redactedKnown).toBe(false);
    // Workday paths carry a repost suffix the bullet id lacks
    expect(splitRedacted(jobs, new Set(["R-77-2"])).redactedKnown).toBe(true);
    expect(splitRedacted(jobs, new Set(["R-770"])).redactedKnown).toBe(false);
  });

  it("a complete list with redacted rows still yields every real row and stays a full fetch", async () => {
    // 19 real rows + 1 redacted on page one, 1 real row on page two: total 21 = rows received
    stub(listRoute([[...fullPage.slice(0, 10), { bulletFields: ["R-293658"] }, ...fullPage.slice(10)], [row(20)]], 21));
    const raws = await new WorkdayAdapter().fetch({ slug: SLUG, location: "IN", limit: 0 });
    expect(raws).toHaveLength(20);
    expect(raws.map((r) => r.atsJobId)).not.toContain(undefined);
    expect(isPartialFetch(raws)).toBe(false);
  });

  it("marks the fetch partial when the redacted row is a posting we already store", async () => {
    stub(listRoute([[...fullPage, { bulletFields: ["R-5000"] }], [row(20)]], 21));
    const raws = await new WorkdayAdapter().fetch({ slug: SLUG, location: "IN", limit: 0, known: new Set(["R-5000"]) });
    expect(raws).toHaveLength(20);
    expect(isPartialFetch(raws)).toBe(true);
  });

  it("marks the fetch partial when fewer rows arrived than the board's total", async () => {
    stub(listRoute([[...fullPage, { bulletFields: ["R-9"] }], [row(20)]], 30));
    const raws = await new WorkdayAdapter().fetch({ slug: SLUG, location: "IN", limit: 0 });
    expect(raws).toHaveLength(20);
    expect(isPartialFetch(raws)).toBe(true);
  });
});

describe("Greenhouse: a work mode in location.name is resolved through offices[]", () => {
  const office = (name: string, location: string | null) => ({ id: 1, name, location });

  it("reads the offices and keeps the mode as a prefix", () => {
    expect(greenhouseLocation("Hybrid", [office("Austin, TX", "Austin, TX, United States"), office("London, United Kingdom", "London, United Kingdom")])).toBe(
      "Hybrid - Austin, TX; London, United Kingdom",
    );
    expect(greenhouseLocation("In-Office", [office("Lisbon, Portugal", "Lisboa, Lisboa, Portugal")])).toBe("Lisbon, Portugal");
    expect(greenhouseLocation("Distributed", [office("Toronto, ON", "Toronto, Ontario, Canada")])).toBe("Remote - Toronto, ON");
    // a mixed mode reads as hybrid, never as fully remote
    expect(greenhouseLocation("Distributed; Hybrid", [office("Remote US", null), office("Denver, CO", "Denver, Colorado, United States")])).toBe("Hybrid - Remote US; Denver, CO");
    // the full location fills in an office name that names no country
    expect(greenhouseLocation("Hybrid", [office("AMER", "United States")])).toBe("Hybrid - United States");
  });

  it("leaves real places, a bare Remote, and office-less rows alone", () => {
    expect(greenhouseLocation("Dublin, Ireland", [office("Dublin", "Dublin, Ireland")])).toBe("Dublin, Ireland");
    expect(greenhouseLocation("Remote", [office("San Francisco, CA", "San Francisco, CA, United States")])).toBe("Remote");
    expect(greenhouseLocation("Hybrid", [])).toBe("Hybrid");
    expect(greenhouseLocation(undefined, undefined)).toBeNull();
    expect(greenhouseLocation("", [office("Pune, India", null)])).toBe("Pune, India");
  });

  it("the adapter uses it on the board API's rows", async () => {
    stub(() =>
      json({
        jobs: [
          { id: 11, title: "Systems Engineer", location: { name: "Hybrid" }, offices: [office("New York, NY", "New York, New York, United States")], first_published: "2026-11-01T00:00:00Z", content: "<p>x</p>" },
          { id: 12, title: "Data Engineer", location: { name: "Berlin, Germany" }, offices: [], content: "<p>y</p>" },
        ],
      }),
    );
    const raws = await new GreenhouseAdapter().fetch({ slug: "example" });
    expect(raws.map((r) => r.locationRaw)).toEqual(["Hybrid - New York, NY", "Berlin, Germany"]);
  });
});

describe("Eightfold v2: an empty board and a changed API both degrade to []", () => {
  const SLUG = "careers.example.com/example.com/v2";

  it("a page config with positions: [] is an empty board (no throw, no notice)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(() => json({ domain: "example.com", branding: { companyName: "Example" }, facets: {}, positions: [], count: 0 }));
    const run = new EightfoldAdapter().fetch({ slug: SLUG, location: "IN" });
    await vi.runAllTimersAsync();
    expect(await run).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a reply with no positions list logs why and returns []", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub(() => json({ domain: "example.com", branding: {} }));
    const run = new EightfoldAdapter().fetch({ slug: SLUG });
    await vi.runAllTimersAsync();
    expect(await run).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[eightfold\] example\.com: .*without a positions list/);
    warn.mockRestore();
  });
});

describe("Himalayas: optional API key, backoff, clean degradation", () => {
  const page = { totalCount: 1, jobs: [{ title: "Backend Engineer", companyName: "Example Co", guid: "https://himalayas.app/companies/example/jobs/backend", locationRestrictions: ["United States"], pubDate: 1794900000 }] };

  it("sends the key as a Bearer token when HIMALAYAS_API_KEY is set", async () => {
    vi.stubEnv("HIMALAYAS_API_KEY", "test-key");
    const calls = stub(() => json(page));
    const raws = await new HimalayasAdapter().fetch({ query: "backend", limit: 20, params: { country: "US" } });
    expect(raws.map((r) => r.title)).toEqual(["Backend Engineer"]);
    const headers = (calls.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("sends no Authorization header without a key", async () => {
    vi.stubEnv("HIMALAYAS_API_KEY", "");
    const calls = stub(() => json(page));
    await new HimalayasAdapter().fetch({ query: "backend", limit: 20, params: { country: "US" } });
    expect(((calls.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("waits out a keyed 429 (Retry-After) and keeps going", async () => {
    vi.stubEnv("HIMALAYAS_API_KEY", "test-key");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    stub(() => (++n === 1 ? json({ error: "rate limited" }, 429, { "retry-after": "2" }) : json(page)));
    const run = new HimalayasAdapter().fetch({ query: "backend", limit: 20, params: { country: "US" } });
    await vi.runAllTimersAsync();
    expect((await run).length).toBe(1);
    expect(n).toBe(2);
  });

  it("keyless and rate-limited: [] with a logged reason, then no requests while paused", async () => {
    vi.stubEnv("HIMALAYAS_API_KEY", "");
    resetHimalayasPause();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = stub(() => json({ message: "Too many requests. Get a free API key." }, 429));
    const run = new HimalayasAdapter().fetch({ query: "backend", params: { country: "GB" } });
    await vi.runAllTimersAsync();
    expect(await run).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(3); // the first try + 2 backoff retries
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[himalayas\] rate-limited \(429\) without an API key.*HIMALAYAS_API_KEY/);
    // the next target in the same poll doesn't wait out the same limit again
    expect(await new HimalayasAdapter().fetch({ query: "frontend", params: { country: "DE" } })).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(3);
    resetHimalayasPause();
    warn.mockRestore();
  });
});

describe("Jobicy: at most one pass an hour per target, enforced in the adapter", () => {
  it("skips a repeat of the same target within the hour, without a request", async () => {
    resetJobicyPacing();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    const calls = stub(() => json({ jobs: [{ id: 1, jobTitle: "Backend Engineer", companyName: "Example Co", url: "https://jobicy.com/jobs/1-x" }], hasMore: false }));
    const a = new JobicyAdapter();
    expect(await a.fetch({ query: "backend", params: { geo: "usa" } })).toHaveLength(1);
    // a second preset, a saved search or a request-bound refresh asks again: no request
    expect(await new JobicyAdapter().fetch({ query: "backend", params: { geo: "usa" } })).toEqual([]);
    expect(calls).toHaveBeenCalledTimes(1);
    // a different target is its own pass
    expect(await a.fetch({ query: "backend", params: { geo: "canada" } })).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(2);
    // an hour later the first target may run again
    vi.setSystemTime(new Date(Date.parse("2026-11-18T10:00:00Z") + JOBICY_MIN_INTERVAL_MS));
    expect(await a.fetch({ query: "backend", params: { geo: "usa" } })).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(3);
    resetJobicyPacing();
  });
});

describe("httpJsonPolite: onGiveUp says why", () => {
  it("reports the last status, or null for a network error", async () => {
    const sleep = async () => {};
    const seen: Array<number | null> = [];
    stub(() => json({}, 429));
    await httpJsonPolite("https://x.example/a", {}, { sleep, retries: 1, onGiveUp: (s) => seen.push(s) });
    stub(() => json({}, 401));
    await httpJsonPolite("https://x.example/a", {}, { sleep, onGiveUp: (s) => seen.push(s) });
    stub(() => {
      throw new Error("ECONNRESET");
    });
    await httpJsonPolite("https://x.example/a", {}, { sleep, onGiveUp: (s) => seen.push(s) });
    stub(() => json({ ok: true }));
    await httpJsonPolite("https://x.example/a", {}, { sleep, onGiveUp: (s) => seen.push(s) });
    expect(seen).toEqual([429, 401, null]);
  });
});
