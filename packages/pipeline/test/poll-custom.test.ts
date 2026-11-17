import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalConfigJson, type DiscoverySource, type DiscoverySourceConfig, type RawPosting } from "@jobflow/core";
import { ADAPTERS } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import { createHash, randomUUID } from "node:crypto";
import { pollAll } from "../src/poll.js";
import type { Embedder } from "../src/embedder.js";

const A = "00000000-0000-0000-0000-00000000000a";
const embedder: Embedder = Object.assign(async () => [0.1, 0.2, 0.3], { id: "test" });

function source(cfg: DiscoverySourceConfig): DiscoverySource {
  return {
    id: randomUUID(),
    tenantId: A,
    label: "feed",
    config: cfg,
    configKey: createHash("sha1").update(canonicalConfigJson(cfg)).digest("hex"),
    enabled: true,
    lastRunAt: null,
    lastStatus: null,
    lastCount: null,
    lastError: null,
    createdAt: new Date(),
  };
}

function item(id: string): RawPosting {
  return {
    source: "rss",
    tier: "tier1",
    atsType: "unknown",
    atsJobId: `k:${id}`,
    companyName: "Acme",
    companySlug: null,
    title: "Backend Engineer",
    jdText: "Go",
    jdHtml: null,
    locationRaw: "Remote",
    applyUrl: `https://example.com/${id}`,
    salaryRaw: null,
    postedAt: null,
    fetchedAt: new Date(),
    raw: {},
  };
}

describe("pollAll — custom discovery sources", () => {
  const originalRss = ADAPTERS.rss!.fetch;
  beforeEach(() => {
    // no live network in tests: anything else that tries to fetch gets a 404
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  });
  afterEach(() => {
    ADAPTERS.rss!.fetch = originalRss;
    vi.unstubAllGlobals();
  });

  it("runs each custom feed once, ingests idempotently and records the run on every row", async () => {
    const repo = new InMemoryRepository();
    await repo.createTenant({ name: "a", id: A });
    const ok = await repo.saveDiscoverySource(source({ kind: "rss", url: "https://feeds.example.com/a.rss", company: null }));
    const bad = await repo.saveDiscoverySource(source({ kind: "rss", url: "https://feeds.example.com/b.rss", company: null }));
    const calls: string[] = [];
    ADAPTERS.rss!.fetch = async (t) => {
      calls.push(String(t.params?.url));
      return String(t.params?.url).endsWith("a.rss") ? [item("1"), item("2")] : [];
    };
    const opts = { embedder, feeds: [], telegramChannels: [], discoverNewSeeds: false, searches: false } as const;
    const stats = await pollAll(repo, opts);
    expect(calls.sort()).toEqual(["https://feeds.example.com/a.rss", "https://feeds.example.com/b.rss"]);
    expect(stats.custom![ok.configKey]).toBe(2);
    const sources = await repo.listDiscoverySources(A);
    expect(sources.find((s) => s.id === ok.id)).toMatchObject({ lastStatus: "ok", lastCount: 2 });
    expect(sources.find((s) => s.id === bad.id)).toMatchObject({ lastStatus: "empty", lastCount: 0 });
    await pollAll(repo, opts);
    expect((await repo.listActivePostings()).filter((p) => p.source === "rss")).toHaveLength(2);
  });
});
