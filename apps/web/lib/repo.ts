import "server-only";
import { createRepository, type Repository } from "@jobflow/db";
import { ensureTenant as ensureTenantFor, seedDemoCorpus } from "@jobflow/service";
import { DEFAULT_TENANT_ID } from "./tenant-constant";

/**
 * One repository per server process. In-memory persists across requests within the
 * process; PGlite / Postgres are durable across restarts.
 */
let repoPromise: Promise<Repository> | null = null;

export function getRepo(): Promise<Repository> {
  if (!repoPromise) {
    repoPromise = createRepository().then(async (repo) => {
      // JOBFLOW_DEMO_DATA=1: an offline, fully fictional corpus (screenshots / UI dev)
      if (process.env.JOBFLOW_DEMO_DATA === "1") await seedDemoCorpus(repo, DEFAULT_TENANT_ID);
      return repo;
    });
  }
  return repoPromise;
}

/** Ensure the tenant's profile + config exist (blank profile; sample only on request). */
export async function ensureTenant(repo: Repository, tenantId: string): Promise<void> {
  await ensureTenantFor(repo, tenantId);
}
