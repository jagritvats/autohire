import "server-only";
import { createRepository, type Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  defaultProfile,
  seedEvidence,
} from "@jobflow/pipeline";
import type { TenantConfig } from "@jobflow/core";

/**
 * One repository per server process. In-memory persists across requests within the
 * process (no more "memoize one run" hack); Postgres is durable across restarts.
 */
let repoPromise: Promise<Repository> | null = null;

export function getRepo(): Promise<Repository> {
  if (!repoPromise) repoPromise = createRepository();
  return repoPromise;
}

/** Ensure the single-tenant profile/config/evidence exist (first-run bootstrap). */
export async function ensureTenant(repo: Repository): Promise<void> {
  const profile = await repo.getProfile(DEFAULT_TENANT);
  if (!profile) {
    await repo.saveProfile(defaultProfile());
    for (const e of seedEvidence()) await repo.saveEvidence(e);
  }
  const config = await repo.getConfig(DEFAULT_TENANT);
  if (!config) {
    const fresh: TenantConfig = {
      tenantId: DEFAULT_TENANT,
      sourcesEnabled: ["greenhouse", "lever", "ashby", "workable", "remotive", "arbeitnow", "hn_whoishiring"],
      automationFlags: { browser: "off", mode: "capture", autosubmit: false, rate: "human", tier3Sources: [] },
      llmChoice: process.env.LLM_PROVIDER ?? "echo",
      llmModel: "",
      llmApiKey: "",
      llmBaseUrl: "",
      digestCadence: "daily",
    };
    await repo.saveConfig(fresh);
  }
}
