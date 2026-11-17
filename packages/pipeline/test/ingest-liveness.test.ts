import { afterEach, describe, expect, it } from "vitest";
import { localEmbed, normalizePosting, type Match } from "@jobflow/core";
import { ADAPTERS, type LivenessTarget } from "@jobflow/adapters";
import { InMemoryRepository } from "@jobflow/db";
import { toNewPosting } from "../src/ingest.js";
import { checkLiveness } from "../src/liveness.js";
import type { Embedder } from "../src/embedder.js";

const T1 = "00000000-0000-0000-0000-000000000001";

const normalized = normalizePosting({
  source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "1", companyName: "Acme", companySlug: "acme",
  title: "Backend Engineer", jdText: "Build services in Java and Postgres.", jdHtml: null, locationRaw: "Bengaluru, India",
  applyUrl: null, salaryRaw: null, postedAt: null, fetchedAt: new Date(), raw: {},
});

function counting(id: string, impl: (t: string) => number[] = () => [0.1, 0.2, 0.3]): Embedder & { calls: number } {
  const fn = Object.assign(async (t: string) => {
    fn.calls++;
    return impl(t);
  }, { id, calls: 0 });
  return fn;
}

describe("embedding reuse on re-poll (cost)", () => {
  it("an unchanged posting reuses its stored vector; a changed JD or another model re-embeds", async () => {
    const m1 = counting("openai:text-embedding-3-small");
    const first = await toNewPosting(normalized, "c1", "Acme", m1);
    expect(m1.calls).toBe(1);
    expect(first.embedKey).toMatch(/^openai:text-embedding-3-small:/);

    const again = await toNewPosting(normalized, "c1", "Acme", m1, first);
    expect(m1.calls).toBe(1);
    expect(again.jdEmbedding).toEqual(first.jdEmbedding);

    await toNewPosting({ ...normalized, jdText: "Now also Kafka." }, "c1", "Acme", m1, first);
    expect(m1.calls).toBe(2);

    const m2 = counting("voyage:3");
    await toNewPosting(normalized, "c1", "Acme", m2, first);
    expect(m2.calls).toBe(1);
  });

  it("a provider that fell back to the local embedder is keyed local, so it's re-embedded later", async () => {
    const flaky = counting("openai:text-embedding-3-small", (t) => localEmbed(t));
    const fellBack = await toNewPosting(normalized, "c1", "Acme", flaky);
    expect(fellBack.embedKey).toMatch(/^local-v1:/);
    await toNewPosting(normalized, "c1", "Acme", flaky, fellBack);
    expect(flaky.calls).toBe(2);
  });
});

describe("dead-link check (§3)", () => {
  const original = ADAPTERS.greenhouse!.isLive;
  afterEach(() => {
    ADAPTERS.greenhouse!.isLive = original;
  });

  it("retires only what the source definitively reports gone, re-verifies the live ones", async () => {
    const repo = new InMemoryRepository();
    const co = await repo.upsertCompany({ name: "Acme", nameNorm: "acme", atsType: "greenhouse", atsSlug: "acme" });
    const answers: Record<string, boolean | null> = { live: true, gone: false, flaky: null };
    const ids: Record<string, string> = {};
    for (const jobId of Object.keys(answers)) {
      const np = await toNewPosting({ ...normalized, atsJobId: jobId }, co.id, "Acme", counting("x"));
      const p = await repo.upsertPosting(np);
      ids[jobId] = p.id;
      const m: Match = {
        id: `m-${jobId}`, tenantId: T1, postingId: p.id, score: 80,
        scoreBreakdown: { semantic: 0, stackAdjacency: 0, archetype: 0, seniority: 0, location: 0, freshness: 0, salary: 0 },
        rulePass: true, whyFit: null, gap: null, stackNote: null, levelNote: null, redFlags: [], generatedAt: new Date(),
      };
      await repo.saveMatches([m]);
    }
    const probed: LivenessTarget[] = [];
    ADAPTERS.greenhouse!.isLive = async (job) => {
      probed.push(job);
      return answers[job.jobId] ?? null;
    };

    const r = await checkLiveness(repo, { tenantId: T1 });
    expect(r).toMatchObject({ checked: 3, live: 1, retired: 1, unknown: 1, unsupported: 0 });
    expect(probed.every((j) => j.slug === "acme")).toBe(true);
    expect((await repo.getPosting(ids.gone!))?.status).toBe("stale");
    expect((await repo.getPosting(ids.flaky!))?.isActive).toBe(true); // an unknown answer is never a closure
    expect((await repo.listMatches(T1)).map((m) => m.posting.atsJobId).sort()).toEqual(["flaky", "live"]);
  });
});

describe("LLM re-rank write-ups persist on matches (§11.6)", () => {
  it("narrates the top cards once, reapplies the cache on later ranks, and redoes it when inputs change", async () => {
    const { rebuildMatches } = await import("../src/match.js");
    const { sampleProfile } = await import("../src/sample.js");
    const repo = new InMemoryRepository();
    const co = await repo.upsertCompany({ name: "Acme", nameNorm: "acme", atsType: "greenhouse", atsSlug: "acme" });
    for (const jobId of ["a", "b", "c"]) {
      await repo.upsertPosting(await toNewPosting({ ...normalized, atsJobId: jobId, dedupKey: `k${jobId}` }, co.id, "Acme", counting("x")));
    }
    let profile = sampleProfile();
    await repo.saveProfile(profile);
    let calls = 0;
    const narrator = {
      model: "test-llm",
      top: 2,
      narrate: async () => {
        calls++;
        return { whyFit: "Your Kafka ledger work maps onto their event pipeline.", gap: "Go ramp.", redFlags: ["On-call"], scoreAdjust: 3 };
      },
    };

    const first = await rebuildMatches(repo, profile, { narrator });
    expect(first).toMatchObject({ narrated: 2, narratedFresh: 2 });
    expect(calls).toBe(2);
    const shown = await repo.listMatches(profile.tenantId);
    expect(shown.filter((m) => m.gap === "Go ramp.")).toHaveLength(2);
    expect(shown.find((m) => m.gap === "Go ramp.")?.redFlags).toContain("On-call");

    // a web settings re-rank has no narrator: the cached write-ups still apply
    const second = await rebuildMatches(repo, profile);
    expect(second).toMatchObject({ narrated: 2, narratedFresh: 0 });
    expect((await repo.listMatches(profile.tenantId)).filter((m) => m.gap === "Go ramp.")).toHaveLength(2);

    // the profile it was judged against changed → stale, re-narrated
    profile = { ...profile, yoe: profile.yoe + 3 };
    await rebuildMatches(repo, profile, { narrator });
    expect(calls).toBe(4);
  });
});
