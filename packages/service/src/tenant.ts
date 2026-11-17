import type { Repository } from "@jobflow/db";
import type { TenantConfig } from "@jobflow/core";
import { blankProfile, sampleEvidence, sampleProfile } from "@jobflow/pipeline";

/**
 * A tenant's default config. Behaviour is data (§6.1): sources, automation flags and the
 * generation provider are edited in Settings / `jobflow config`. The LLM key starts blank —
 * whether the operator's env key may be used is decided at call time (JOBFLOW_OPERATOR_LLM).
 */
export function defaultConfig(tenantId: string, preset = "india"): TenantConfig {
  return {
    tenantId,
    sourcesEnabled: ["greenhouse", "lever", "ashby", "workable", "remotive", "arbeitnow", "hn_whoishiring"],
    automationFlags: { browser: "off", mode: "capture", autosubmit: false, rate: "human", tier3Sources: [] },
    llmChoice: process.env.LLM_PROVIDER || "echo",
    llmModel: "",
    llmApiKey: "",
    llmBaseUrl: "",
    digestCadence: "daily",
    discoveryPresets: [preset],
    discoveryPreset: preset,
    presetFeedsDisabled: [],
  };
}

const ensured = new Set<string>();

/**
 * Make sure the tenant's profile + config exist (first-run bootstrap). Real users start
 * BLANK and onboard with their own résumé — nobody starts as a built-in persona
 * (invariant #3). The fictional sample is loaded only when JOBFLOW_SAMPLE_PROFILE=1
 * (demos / screenshots) or when `opts.sample` asks for it.
 */
export async function ensureTenant(repo: Repository, tenantId: string, opts: { sample?: boolean } = {}): Promise<void> {
  if (ensured.has(tenantId) && !opts.sample) return;
  if (!(await repo.getTenant(tenantId).catch(() => null))) await repo.createTenant({ id: tenantId, name: "default" }).catch(() => undefined);
  const profile = await repo.getProfile(tenantId);
  if (!profile) {
    if (opts.sample || process.env.JOBFLOW_SAMPLE_PROFILE === "1") {
      await repo.saveProfile(sampleProfile(tenantId));
      for (const e of sampleEvidence(tenantId)) await repo.saveEvidence(e);
    } else {
      await repo.saveProfile(blankProfile(tenantId));
    }
  }
  if (!(await repo.getConfig(tenantId))) await repo.saveConfig(defaultConfig(tenantId));
  ensured.add(tenantId);
}

/** Replace a tenant's profile + evidence with the fictional sample (explicit user action). */
export async function loadSampleProfile(repo: Repository, tenantId: string): Promise<void> {
  for (const e of await repo.listEvidence(tenantId)) await repo.deleteEvidence(tenantId, e.id);
  await repo.saveProfile(sampleProfile(tenantId));
  for (const e of sampleEvidence(tenantId)) await repo.saveEvidence(e);
}
