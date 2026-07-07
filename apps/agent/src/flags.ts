import { readFlags, type AutomationFlags } from "@jobflow/autofill";
import type { TenantConfig } from "@jobflow/core";

/**
 * The agent's EFFECTIVE flags = the machine-level env gates (the hard floor) layered
 * with the web settings (db tenant_config). Both must agree to act (§7.1):
 *   - browser actions run only if env JOBFLOW_BROWSER=on AND the web master is on,
 *   - form-fill needs env JOBFLOW_BROWSER_MODE=fill,
 *   - autosubmit is never permitted,
 *   - a Tier-3 source is active only if opted in (web), within any env allow-list.
 * Turning anything on is deliberate and lives partly outside the app (env), so the
 * web can never unilaterally start browsing your sessions.
 */
export interface EffectiveFlags {
  browserOn: boolean;
  mode: "capture" | "fill";
  autosubmit: false;
  rate: "human" | "fast";
  enabledSources: string[];
  env: AutomationFlags;
}

export function effectiveFlags(config: TenantConfig | null): EffectiveFlags {
  const env = readFlags();
  const dbFlags = config?.automationFlags;
  const dbBrowserOn = (dbFlags?.browser ?? "off") === "on";
  const dbSources = dbFlags?.tier3Sources ?? [];
  const envAllow = env.tier3Sources;
  const enabledSources = envAllow.length ? dbSources.filter((s) => envAllow.includes(s)) : dbSources;

  return {
    browserOn: env.browser === "on" && dbBrowserOn,
    mode: env.mode, // env governs fill vs capture
    autosubmit: false,
    rate: env.rate,
    enabledSources,
    env,
  };
}
