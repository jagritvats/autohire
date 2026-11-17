import "server-only";
import { createRepository, type Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  blankProfile,
  sampleEvidence,
  sampleProfile,
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

/**
 * Ensure the tenant's profile/config exist (first-run bootstrap). Real users start
 * BLANK and onboard with their own résumé; the fictional sample persona is loaded only
 * when JOBFLOW_SAMPLE_PROFILE=1 (demos, screenshots).
 */
export async function ensureTenant(repo: Repository): Promise<void> {
  const profile = await repo.getProfile(DEFAULT_TENANT);
  if (!profile) {
    if (process.env.JOBFLOW_SAMPLE_PROFILE === "1") {
      await repo.saveProfile(sampleProfile());
      for (const e of sampleEvidence()) await repo.saveEvidence(e);
    } else {
      await repo.saveProfile(blankProfile());
    }
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
      discoveryPreset: "india",
      presetFeedsDisabled: [],
    };
    await repo.saveConfig(fresh);
  }
}
