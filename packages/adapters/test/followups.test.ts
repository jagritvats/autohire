import { afterEach, describe, expect, it, vi } from "vitest";
import { isPartialFetch } from "../src/types.js";
import { WorkdayAdapter, splitRedacted } from "../src/ats/workday.js";

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
