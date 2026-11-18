import { COUNTRY_NAMES } from "@jobflow/adapters";
import { EUROPE_CODES, type RemoteGeo } from "@jobflow/core";
import { listPresets, suggestPreset } from "@jobflow/pipeline";

/** What a client component needs to show the built-in discovery presets. */
export interface PresetOption {
  id: string;
  label: string;
  description: string;
  /** the remote regions a new user in this preset's market starts from */
  remoteGeoOk: RemoteGeo[];
}

/** The server's preset suggestion per home country, so the client never hard-codes ids. */
export interface PresetSuggestions {
  /** ISO-2 → the preset `suggestPreset` picks for someone living there */
  byCountry: Record<string, string>;
  /** what `suggestPreset` picks with no country known (the market-neutral preset) */
  fallback: string;
}

/**
 * The preset list (`listPresets()`) plus `suggestPreset`'s answer for every country the app
 * knows, computed on the server: the wizard and the Search chips then show every preset
 * (canada, and whatever comes next) without a client-side copy of the list or its rules.
 */
export function presetChoices(): { options: PresetOption[]; suggest: PresetSuggestions } {
  const options = listPresets().map((p) => ({ id: p.id, label: p.label, description: p.description, remoteGeoOk: [...p.profileDefaults.remoteGeoOk] }));
  const codes = new Set<string>([...Object.keys(COUNTRY_NAMES), ...EUROPE_CODES, ...listPresets().flatMap((p) => p.markets)]);
  const byCountry: Record<string, string> = {};
  for (const code of codes) byCountry[code] = suggestPreset({ currency: "USD", locationWeights: [], homeCountry: code }).id;
  return { options, suggest: { byCountry, fallback: suggestPreset({ currency: "USD", locationWeights: [] }).id } };
}
