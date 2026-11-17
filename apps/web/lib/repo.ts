import "server-only";
import { createRepository, type Repository } from "@jobflow/db";
import { ensureTenant as ensureTenantFor } from "@jobflow/service";

/**
 * One repository per server process. In-memory persists across requests within the
 * process; PGlite / Postgres are durable across restarts.
 */
let repoPromise: Promise<Repository> | null = null;

export function getRepo(): Promise<Repository> {
  if (!repoPromise) repoPromise = createRepository();
  return repoPromise;
}

/** Ensure the tenant's profile + config exist (blank profile; sample only on request). */
export async function ensureTenant(repo: Repository, tenantId: string): Promise<void> {
  await ensureTenantFor(repo, tenantId);
}
