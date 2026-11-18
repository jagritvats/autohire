import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { JOB_RUNTIME, normCompany, normalizePosting, type Job, type JobType, type RawPosting } from "@jobflow/core";
import { toNewPosting } from "@jobflow/pipeline";
import { loadSampleProfile, runCloudJob, runNextCloudJob, startCloudJobDrainer, type JobCtx } from "../src/index.js";

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });
const ctx: JobCtx = { embedder: embed };

async function seedPosting(repo: InMemoryRepository, title: string, jd: string) {
  const company = await repo.upsertCompany({ name: "Acme Payments", nameNorm: normCompany("Acme Payments"), atsType: "greenhouse", atsSlug: "acme" });
  const raw: RawPosting = {
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: `${title}-1`, companyName: company.name,
    companySlug: "acme", title, jdText: jd, jdHtml: null, locationRaw: "Remote", applyUrl: "https://example.com/apply",
    salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
  };
  return repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embed));
}

const enqueue = (repo: InMemoryRepository, tenantId: string, type: JobType, payload: Record<string, unknown> = {}) =>
  repo.enqueueJob({ tenantId, type, runtime: JOB_RUNTIME[type], payload });

const LOCAL_TYPES = (Object.keys(JOB_RUNTIME) as JobType[]).filter((t) => JOB_RUNTIME[t] === "local");

describe("cloud job runner (service)", () => {
  it("rank: ranks the caller's tenant through runNextCloudJob and records the result", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await seedPosting(repo, "Backend Engineer", "Java, Kafka, Postgres, distributed systems. Remote worldwide.");
    await loadSampleProfile(repo, t.id);
    const job = await enqueue(repo, t.id, "rank");

    const out = await runNextCloudJob(repo, ctx);
    expect(out?.status).toBe("done");
    expect(out?.result).toMatchObject({ tenants: 1, skipped: 0, ranked: 1 });
    const [row] = await repo.listJobs(t.id);
    expect(row).toMatchObject({ id: job.id, status: "done", error: null });
    expect(await repo.listMatches(t.id)).toHaveLength(1);
    expect(await runNextCloudJob(repo, ctx)).toBeNull(); // queue drained
  });

  it("rank never scores an un-onboarded profile", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await seedPosting(repo, "Backend Engineer", "Java. Remote.");
    const r = await runCloudJob(repo, (await enqueue(repo, t.id, "rank")) as Job, ctx);
    expect(r).toMatchObject({ tenants: 0, skipped: 1 });
    expect(await repo.listMatches(t.id)).toHaveLength(0);
  });

  it("purge: retires postings older than the threshold; a purge without one fails instead of retiring everything", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    const old = await seedPosting(repo, "Old Role", "Go. Remote.");
    await seedPosting(repo, "Fresh Role", "Go. Remote.");
    (await repo.getPosting(old.id))!.lastSeen = new Date(Date.now() - 90 * 86_400_000);

    await enqueue(repo, t.id, "purge", { olderThanDays: 30, field: "lastSeen" });
    const out = await runNextCloudJob(repo, ctx);
    expect(out).toMatchObject({ status: "done", result: { purged: 1 } });
    expect((await repo.listActivePostings()).map((p) => p.title)).toEqual(["Fresh Role"]);

    await enqueue(repo, t.id, "purge");
    const bad = await runNextCloudJob(repo, ctx);
    expect(bad?.status).toBe("error");
    expect(bad?.error).toMatch(/olderThanDays/);
    expect(await repo.listActivePostings()).toHaveLength(1);
  });

  it("errors are recorded with secrets masked", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await seedPosting(repo, "Backend Engineer", "Java. Remote.");
    await loadSampleProfile(repo, t.id);
    await enqueue(repo, t.id, "rank");
    const leaky = Object.assign(
      async (): Promise<number[]> => {
        throw new Error("401 Incorrect API key provided: sk-ant-abcdefghijklmnop");
      },
      { id: "leaky" },
    );
    const failing: JobCtx = { embedder: leaky };
    const out = await runNextCloudJob(repo, failing);
    expect(out?.status).toBe("error");
    expect(out?.error).not.toContain("abcdefghijklmnop");
    expect((await repo.listJobs(t.id))[0]?.error).toContain("sk-ant-***");
  });

  it("refuses every LOCAL-agent job type, even one mislabelled as cloud (invariant #1)", async () => {
    expect(LOCAL_TYPES).toEqual(expect.arrayContaining(["tier3_poll", "enrich_t3", "form_fill", "import_yc", "local_board_poll"]));
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    for (const type of LOCAL_TYPES) {
      const local = await enqueue(repo, t.id, type);
      await expect(runCloudJob(repo, local, ctx)).rejects.toThrow(/LOCAL-agent job/);
      const forged = { ...local, runtime: "cloud" } as Job;
      await expect(runCloudJob(repo, forged, ctx)).rejects.toThrow(/LOCAL-agent job/);
    }
  });

  it("the drainer runs queued cloud jobs one by one and never claims a local job", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await seedPosting(repo, "Backend Engineer", "Java, Kafka. Remote.");
    await loadSampleProfile(repo, t.id);
    const fill = await enqueue(repo, t.id, "form_fill", { postingId: "x" });
    const tier3 = await enqueue(repo, t.id, "tier3_poll", { source: "naukri" });
    await enqueue(repo, t.id, "rank");
    await enqueue(repo, t.id, "purge", { olderThanDays: 30 });

    const drainer = startCloudJobDrainer(repo, ctx, { intervalMs: 60_000 });
    await drainer.idle();
    drainer.stop();

    const byId = new Map((await repo.listJobs(t.id)).map((j) => [j.id, j]));
    const cloud = [...byId.values()].filter((j) => j.runtime === "cloud");
    expect(cloud.map((j) => j.status)).toEqual(["done", "done"]);
    expect(byId.get(fill.id)?.status).toBe("queued");
    expect(byId.get(tier3.id)?.status).toBe("queued");
    // the local agent still finds them
    expect((await repo.claimJob("local"))?.id).toBe(fill.id);
  });

  it("the drainer re-queues a job a previous server left running", async () => {
    const repo = new InMemoryRepository();
    const t = await repo.createTenant({ name: "t" });
    await enqueue(repo, t.id, "purge", { olderThanDays: 30 });
    const stuck = (await repo.claimJob("cloud"))!;
    stuck.pickedAt = new Date(Date.now() - 2 * 3_600_000);

    const drainer = startCloudJobDrainer(repo, ctx, { intervalMs: 60_000 });
    await drainer.idle();
    drainer.stop();
    expect((await repo.listJobs(t.id))[0]).toMatchObject({ id: stuck.id, status: "done" });
  });
});
