import { randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import type { Application } from "@jobflow/core";
import { estimatePostingSalaries } from "@jobflow/pipeline";
import { seedDemoPostings } from "./demo-corpus.js";
import { rankTenant } from "./feed.js";
import { loadSampleProfile } from "./tenant.js";

/**
 * Demo mode's starting state (JOBFLOW_DEMO_DATA=1): the fictional corpus (`demo-corpus.ts`),
 * the fictional sample candidate, and a few tracked applications.
 */
let seeded = false;

/** Seed the fictional corpus + sample candidate (idempotent per process). */
export async function seedDemoCorpus(repo: Repository, tenantId: string): Promise<void> {
  if (seeded) return;
  seeded = true;
  const now = Date.now();
  const { ids } = await seedDemoPostings(repo, { now });
  // pay estimates for the postings that state none, as after a real sync
  await estimatePostingSalaries(repo).catch(() => undefined);
  await loadSampleProfile(repo, tenantId);
  await rankTenant(repo, tenantId);
  // a few tracked applications so the pipeline view has something to show
  const statuses: Application["status"][] = ["applied", "interviewing", "ready", "saved"];
  for (const [i, status] of statuses.entries()) {
    const postingId = ids[i];
    if (!postingId) continue;
    await repo.upsertApplication({
      id: randomUUID(), tenantId, postingId, status, appliedVia: status === "applied" || status === "interviewing" ? "manual" : null,
      tailoredResumeUrl: null, resumeVariant: null, answers: {}, submittedAt: null,
      nextAction: status === "interviewing" ? "System design round" : null,
      nextActionAt: status === "interviewing" ? new Date(now + 3 * 86_400_000) : null, outcome: null,
    });
  }
}
