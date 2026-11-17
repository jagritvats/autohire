import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePosting, scopedJobId } from "@jobflow/core";
import { parseFeed, decodeXmlEntities } from "../src/feeds/xml.js";
import { RssFeedAdapter, atsLinksFromRaws, parseRssItems, splitTitleCompany, takeFeedError } from "../src/feeds/rss.js";
import { JsonFeedAdapter, getPath, parseJsonFeed } from "../src/feeds/jsonfeed.js";
import { checkUrlSyntax, isBlockedAddress, safeUrl, UnsafeUrlError } from "../src/net.js";
import { WorkdayAdapter, findCountrySites } from "../src/ats/workday.js";
import { isPartialFetch } from "../src/types.js";
import { ADAPTERS } from "../src/registry.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Remote Dev Jobs</title>
  <link>https://example.org/</link>
  <item>
    <title><![CDATA[Senior Backend Engineer at Acme & Co (Remote, EU)]]></title>
    <link>https://boards.greenhouse.io/acme/jobs/12345</link>
    <guid isPermaLink="false">job-12345</guid>
    <pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate>
    <description>&lt;p&gt;Build &amp;amp; run &lt;b&gt;Go&lt;/b&gt; services &#8211; Postgres, Kafka.&lt;/p&gt;</description>
    <category>Engineering</category>
  </item>
  <item>
    <title>Globex is hiring a Platform Engineer</title>
    <link>https://globex.example.com/careers/platform</link>
    <dc:creator>Globex</dc:creator>
    <content:encoded><![CDATA[<p>Kubernetes, Terraform. <i>Hybrid</i> in Berlin.</p>]]></content:encoded>
  </item>
  <item>
    <title>Data Engineer</title>
    <link>https://jobs.example.net/data-engineer?utm=1</link>
    <dc:creator>jane@example.net</dc:creator>
    <description>Spark &amp; Airflow</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Hiring feed</title>
  <entry>
    <title type="html">Staff SRE &lt;b&gt;remote&lt;/b&gt;</title>
    <link rel="self" href="https://example.org/self/1"/>
    <link rel="alternate" href="https://jobs.lever.co/initech/abc-123"/>
    <id>tag:example.org,2026:1</id>
    <updated>2026-11-15T08:30:00Z</updated>
    <author><name>Initech</name></author>
    <content type="html"><![CDATA[<ul><li>SRE for <b>Initech</b></li></ul>]]></content>
  </entry>
</feed>`;

describe("feed XML parsing (RSS 2.0 / Atom, CDATA, entities)", () => {
  it("parses RSS items with CDATA titles, escaped HTML descriptions and namespaced fields", () => {
    const feed = parseFeed(RSS);
    expect(feed.kind).toBe("rss");
    expect(feed.title).toBe("Remote Dev Jobs");
    expect(feed.items).toHaveLength(3);
    const [a, b] = feed.items;
    expect(a!.title).toBe("Senior Backend Engineer at Acme & Co (Remote, EU)"); // CDATA literal, & kept
    expect(a!.guid).toBe("job-12345");
    expect(a!.link).toBe("https://boards.greenhouse.io/acme/jobs/12345");
    expect(a!.published).toBe("2026-11-16T10:00:00.000Z");
    // decoded ONCE: &amp;amp; → &amp; (HTML), &#8211; → –
    expect(a!.description).toBe("<p>Build &amp; run <b>Go</b> services – Postgres, Kafka.</p>");
    expect(a!.categories).toEqual(["Engineering"]);
    expect(b!.author).toBe("Globex");
    expect(b!.description).toContain("Kubernetes");
  });

  it("parses Atom entries (alternate link, author name, html content)", () => {
    const feed = parseFeed(ATOM);
    expect(feed.kind).toBe("atom");
    const e = feed.items[0]!;
    expect(e.title).toBe("Staff SRE <b>remote</b>");
    expect(e.link).toBe("https://jobs.lever.co/initech/abc-123");
    expect(e.guid).toBe("tag:example.org,2026:1");
    expect(e.author).toBe("Initech");
    expect(e.published).toBe("2026-11-15T08:30:00.000Z");
  });

  it("non-feeds parse to nothing, entities decode once", () => {
    expect(parseFeed("<html><body>hi</body></html>").items).toEqual([]);
    expect(decodeXmlEntities("&amp;lt; &#x41; &#66; &nbsp;&bogus;")).toBe("&lt; A B  &bogus;");
  });
});

describe("RssFeedAdapter", () => {
  const fixed = (xml: string) => async () => xml;

  it("maps items to postings: company from config / title pattern / creator, scoped ids", async () => {
    const raws = await new RssFeedAdapter(fixed(RSS)).fetch({ params: { url: "https://example.org/feed.xml", feedKey: "k1" } });
    expect(raws).toHaveLength(3);
    const [a, b, c] = raws;
    expect(a!.source).toBe("rss");
    expect(a!.tier).toBe("tier1");
    expect(a!.atsJobId).toBe("k1:job-12345");
    expect(scopedJobId(a!)).toBe("rss:k1:job-12345");
    expect(a!.companyName).toBe("Acme & Co");
    expect(a!.title).toBe("Senior Backend Engineer");
    expect(a!.locationRaw).toBe("Remote, EU");
    expect(a!.jdText).toContain("Go");
    expect(b!.companyName).toBe("Globex");
    expect(b!.title).toBe("Platform Engineer");
    expect(c!.companyName).toBe("Unknown"); // a mailbox creator is not an employer
    expect(c!.atsJobId).toMatch(/^k1:[0-9a-f]{40}$/); // no guid → sha1(link)
    // normalizes like any other source
    expect(normalizePosting(a!).atsJobId).toBe("rss:k1:job-12345");
  });

  it("a configured company wins", async () => {
    const raws = await new RssFeedAdapter(fixed(RSS)).fetch({ params: { url: "https://x.example/f", feedKey: "k1", company: "Acme & Co" } });
    expect(raws.every((r) => r.companyName === "Acme & Co")).toBe(true);
  });

  it("two feeds with the same guid get distinct scoped ids (no cross-feed collision)", async () => {
    const one = await new RssFeedAdapter(fixed(RSS)).fetch({ params: { url: "https://a.example/f", feedKey: "feedA" } });
    const two = await new RssFeedAdapter(fixed(RSS)).fetch({ params: { url: "https://b.example/f", feedKey: "feedB" } });
    expect(scopedJobId(one[0]!)).toBe("rss:feedA:job-12345");
    expect(scopedJobId(two[0]!)).toBe("rss:feedB:job-12345");
    expect(scopedJobId(one[0]!)).not.toBe(scopedJobId(two[0]!));
  });

  it("ATS links are exposed for board discovery", async () => {
    const raws = await new RssFeedAdapter(fixed(RSS)).fetch({ params: { url: "https://x.example/f", feedKey: "k" } });
    expect(atsLinksFromRaws(raws)).toEqual(["https://boards.greenhouse.io/acme/jobs/12345"]);
    const atom = parseRssItems(parseFeed(ATOM).items, { feedKey: "a" });
    expect(atsLinksFromRaws(atom)).toEqual(["https://jobs.lever.co/initech/abc-123"]);
  });

  it("a failed or non-feed fetch is [] with a recorded error, never a throw", async () => {
    const failing = new RssFeedAdapter(async () => {
      throw new UnsafeUrlError("address 10.0.0.1 is private/reserved");
    });
    expect(await failing.fetch({ params: { url: "https://10.0.0.1/f", feedKey: "bad" } })).toEqual([]);
    expect(takeFeedError("bad")).toMatch(/private/);
    expect(takeFeedError("bad")).toBeNull(); // read once
    expect(await new RssFeedAdapter(fixed("<html/>")).fetch({ params: { url: "https://x.example/", feedKey: "h" } })).toEqual([]);
    expect(takeFeedError("h")).toMatch(/not an RSS/);
  });

  it("title patterns", () => {
    expect(splitTitleCompany("Backend Engineer @ Initech")).toEqual({ title: "Backend Engineer", company: "Initech" });
    expect(splitTitleCompany("Hooli: Senior SRE")).toEqual({ title: "Senior SRE", company: "Hooli" });
    expect(splitTitleCompany("Senior Engineer")).toEqual({ title: "Senior Engineer", company: null });
  });

  it("is registered as a cloud tier-1 adapter", () => {
    expect(ADAPTERS.rss!.tier).toBe("tier1");
    expect(ADAPTERS.json_feed!.tier).toBe("tier1");
  });
});

describe("JsonFeedAdapter (dot-path mapping)", () => {
  it("defaults follow jsonfeed.org", () => {
    const doc = {
      version: "https://jsonfeed.org/version/1.1",
      items: [
        { id: "1", title: "Backend Engineer", url: "https://jobs.example/1", content_html: "<p>Go</p>", date_published: "2026-11-10T00:00:00Z", company: "Acme" },
        { id: "2", title: "", url: "https://jobs.example/2" },
      ],
    };
    const raws = parseJsonFeed(doc, {}, { feedKey: "jf" });
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ source: "json_feed", atsJobId: "jf:1", companyName: "Acme", title: "Backend Engineer", applyUrl: "https://jobs.example/1" });
    expect(raws[0]!.postedAt).toBe("2026-11-10T00:00:00.000Z");
    expect(scopedJobId(raws[0]!)).toBe("json_feed:jf:1");
  });

  it("custom nested mapping, epoch dates, root arrays", () => {
    const doc = {
      data: {
        jobs: [
          { ref: 77, role: { name: "SRE" }, org: { name: "Globex" }, links: [{ href: "https://g.example/77" }], where: ["Berlin", "Remote"], ts: 1_763_000_000, pay: "EUR 80000 - 95000" },
        ],
      },
    };
    const mapping = { itemsPath: "data.jobs", id: "ref", title: "role.name", company: "org", url: "links.0.href", location: "where", description: null, postedAt: "ts", salary: "pay" };
    const [r] = parseJsonFeed(doc, mapping, { feedKey: "x" });
    expect(r).toMatchObject({ atsJobId: "x:77", title: "SRE", companyName: "Globex", applyUrl: "https://g.example/77", locationRaw: "Berlin; Remote", salaryRaw: "EUR 80000 - 95000" });
    expect(r!.postedAt).toBe(new Date(1_763_000_000 * 1000).toISOString());
    expect(parseJsonFeed([{ id: "a", title: "T", url: "https://u.example" }], { itemsPath: "" }, { feedKey: "r" })).toHaveLength(1);
    expect(getPath({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
  });

  it("adapter: mapping passed as JSON, bad JSON is [] + error", async () => {
    const ok = new JsonFeedAdapter(async () => JSON.stringify({ results: [{ uid: "z", name: "Dev", url: "https://u.example/z" }] }));
    const raws = await ok.fetch({ params: { url: "https://u.example/feed.json", feedKey: "m", mapping: JSON.stringify({ itemsPath: "results", id: "uid", title: "name" }) } });
    expect(raws.map((r) => r.atsJobId)).toEqual(["m:z"]);
    const bad = new JsonFeedAdapter(async () => "<html>");
    expect(await bad.fetch({ params: { url: "https://u.example/x", feedKey: "bj" } })).toEqual([]);
    expect(takeFeedError("bj")).toMatch(/JSON/);
  });
});

describe("safeUrl (SSRF guard for user-supplied URLs)", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const rejects = async (u: string, resolve?: (h: string) => Promise<string[]>) =>
    expect(safeUrl(u, resolve ? { resolve } : {})).rejects.toBeInstanceOf(UnsafeUrlError);

  it("rejects loopback, private, link-local/metadata, CGNAT, IPv6 local and non-https", async () => {
    await rejects("https://localhost/feed");
    await rejects("https://foo.localhost/feed");
    await rejects("https://127.0.0.1/feed");
    await rejects("https://10.1.2.3/feed");
    await rejects("https://172.16.0.1/feed");
    await rejects("https://172.31.255.255/feed");
    await rejects("https://192.168.1.10/feed");
    await rejects("https://169.254.169.254/latest/meta-data/");
    await rejects("https://100.64.0.1/feed");
    await rejects("https://0.0.0.0/feed");
    await rejects("https://[::1]/feed");
    await rejects("https://[fc00::1]/feed");
    await rejects("https://[fd12:3456::1]/feed");
    await rejects("https://[fe80::1]/feed");
    await rejects("https://[::ffff:127.0.0.1]/feed");
    await rejects("https://[::ffff:a9fe:a9fe]/feed"); // mapped 169.254.169.254
    await rejects("https://2130706433/feed"); // decimal 127.0.0.1
    await rejects("file:///etc/passwd");
    await rejects("ftp://example.com/feed");
    await rejects("http://example.com/feed"); // http off by default
    await rejects("https://user:pass@example.com/feed");
    await rejects("https://intranet/feed"); // single-label name
    await rejects("https://metadata.google.internal/computeMetadata/v1/");
    await rejects("not a url");
  });

  it("rejects a public name that resolves to a private address (any answer)", async () => {
    await rejects("https://feeds.example.com/x", async () => ["93.184.216.34", "10.0.0.5"]);
    await rejects("https://feeds.example.com/x", async () => ["::1"]);
    await rejects("https://feeds.example.com/x", async () => []);
  });

  it("accepts public https URLs; http only when JOBFLOW_ALLOW_HTTP_FEEDS=1", async () => {
    expect((await safeUrl("https://feeds.example.com/jobs.rss", { resolve: publicResolver })).hostname).toBe("feeds.example.com");
    expect((await safeUrl("https://93.184.216.34/jobs.rss")).hostname).toBe("93.184.216.34");
    expect((await safeUrl("https://[2606:4700::1111]/x")).hostname).toBe("[2606:4700::1111]");
    vi.stubEnv("JOBFLOW_ALLOW_HTTP_FEEDS", "1");
    try {
      expect(checkUrlSyntax("http://feeds.example.com/x").protocol).toBe("http:");
      await rejects("http://127.0.0.1/x"); // still never a private address
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("address classification", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.100.100.100", "::1", "fc00::1", "fe80::1", "::", "::ffff:10.0.0.1", "64:ff9b::a9fe:a9fe"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
});

describe("Workday: country sites without a separator + unfiltered fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches sites like 'India Remote' / 'Remote (India)', never Indiana", () => {
    const facets = [
      {
        facetParameter: "locations",
        values: [
          { descriptor: "India Remote", id: "ir" },
          { descriptor: "Remote (India)", id: "ri" },
          { descriptor: "Indianapolis, IN", id: "indy" },
          { descriptor: "Fort Wayne, Indiana", id: "fw" },
        ],
      },
    ];
    expect(findCountrySites(facets, "India")).toEqual({ param: "locations", ids: ["ir", "ri"] });
  });

  it("no country facet/site → an unfiltered, capped list (marked partial), rows placed elsewhere dropped", async () => {
    const page = {
      total: 3,
      facets: [{ facetParameter: "locations", values: [{ descriptor: "Austin, TX", id: "aus" }, { descriptor: "Bengaluru Office", id: "blr" }] }],
      jobPostings: [
        { title: "Software Engineer", externalPath: "/job/Bengaluru/Software-Engineer_R1", locationsText: "Bengaluru", postedOn: "Posted Today" },
        { title: "Backend Engineer", externalPath: "/job/Austin/Backend-Engineer_R2", locationsText: "Austin, TX", postedOn: "Posted Today" },
        { title: "Platform Engineer", externalPath: "/job/x/Platform-Engineer_R3", locationsText: "2 Locations", postedOn: "Posted Yesterday" },
      ],
    };
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(url).endsWith("/jobs")) return new Response(JSON.stringify(page), { status: 200 });
        return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: "<p>Go</p>" } }), { status: 200 });
      }),
    );
    const raws = await new WorkdayAdapter().fetch({ slug: "acme.wd5.myworkdayjobs.com/acme/External", location: "IN" });
    // the board isn't silently empty any more
    expect(raws.map((r) => r.atsJobId)).toEqual(["R1", "R3"]); // Austin dropped: confidently elsewhere
    expect(raws[0]!.locationRaw).toBe("Bengaluru, India"); // the row's own text places it in India
    expect(raws[1]!.locationRaw).toBe("2 Locations"); // unknown — never asserted to be India
    expect(isPartialFetch(raws)).toBe(true); // ingest must not markStale against it
    // the list call was unfiltered
    const listCalls = calls.filter((c) => c.url.endsWith("/jobs"));
    expect(listCalls.every((c) => JSON.stringify((c.body as { appliedFacets: object }).appliedFacets) === "{}")).toBe(true);
  });

  it("a matched country facet is applied as before and the full list is not partial", async () => {
    const page = {
      total: 1,
      facets: [{ facetParameter: "Location_Country", values: [{ descriptor: "India", id: "c-in" }] }],
      jobPostings: [{ title: "SDE", externalPath: "/job/Pune/SDE_R9", locationsText: "Pune", postedOn: "Posted Today" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/jobs")
          ? new Response(JSON.stringify(page), { status: 200 })
          : new Response(JSON.stringify({ jobPostingInfo: {} }), { status: 200 }),
      ),
    );
    const raws = await new WorkdayAdapter().fetch({ slug: "acme.wd5.myworkdayjobs.com/acme/External", location: "IN" });
    expect(raws.map((r) => r.locationRaw)).toEqual(["Pune, India"]);
    expect(isPartialFetch(raws)).toBe(false);
  });
});
