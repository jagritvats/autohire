import { EUROPE_CODES, effectiveHomeCountry, effectiveMarkets, type ProfilePrefs } from "@jobflow/core";
import type { DiscoveryPreset } from "./types.js";
import { INDIA_PRESET } from "./india.js";
import { US_PRESET } from "./us.js";
import { EU_UK_PRESET } from "./eu-uk.js";
import { GLOBAL_REMOTE_PRESET } from "./global-remote.js";

export * from "./types.js";
export { INDIA_PRESET, DEFAULT_DISCOVERY_FEEDS, DEFAULT_TELEGRAM_CHANNELS } from "./india.js";
export { US_PRESET } from "./us.js";
export { EU_UK_PRESET } from "./eu-uk.js";
export { GLOBAL_REMOTE_PRESET } from "./global-remote.js";
export { REMOTE_FIRST_COMPANIES, US_COMPANIES, EU_UK_COMPANIES } from "./companies.js";

/** the preset existing installs (and an unknown id) fall back to — today's behaviour. */
export const DEFAULT_PRESET_ID = "india";

const PRESETS: readonly DiscoveryPreset[] = [INDIA_PRESET, GLOBAL_REMOTE_PRESET, US_PRESET, EU_UK_PRESET];

export function listPresets(): DiscoveryPreset[] {
  return [...PRESETS];
}

/** the preset by id, or null when there's no such preset. */
export function getPreset(id: string | null | undefined): DiscoveryPreset | null {
  const key = (id ?? "").trim().toLowerCase();
  return PRESETS.find((p) => p.id === key) ?? null;
}

/**
 * Suggest a preset for a profile (onboarding): the user's home country / markets decide;
 * with neither known, the market-neutral `global-remote`.
 */
export function suggestPreset(prefs: Pick<ProfilePrefs, "currency" | "locationWeights"> & Partial<Pick<ProfilePrefs, "homeCountry" | "markets">>): DiscoveryPreset {
  const home = effectiveHomeCountry(prefs);
  const markets = effectiveMarkets(prefs);
  const first = home || markets[0] || "";
  if (first === "IN") return INDIA_PRESET;
  if (first === "US") return US_PRESET;
  if (first && EUROPE_CODES.has(first)) return EU_UK_PRESET;
  return GLOBAL_REMOTE_PRESET;
}
