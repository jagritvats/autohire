import type { ProfilePrefs } from "../schema/entities.js";
import type { RemoteGeo } from "../schema/enums.js";
import { countryCodeFromText, remoteGeosForCountry } from "../normalize/location.js";

/**
 * Region-neutral matching (§11.3, product plan "Region"): nothing about where the user
 * lives is assumed. The home country is what they said (`prefs.homeCountry`), else
 * what their currency or location-preference labels clearly imply, else unknown ("") —
 * and an unknown home is treated neutrally (no "abroad" penalty or exclusion).
 */

/** currencies that pin one country (USD/EUR don't: used by many, and USD is the default). */
const CURRENCY_HOME: Readonly<Record<string, string>> = {
  INR: "IN",
  GBP: "GB",
  CAD: "CA",
  AUD: "AU",
  SGD: "SG",
};

type RegionPrefs = Pick<ProfilePrefs, "currency" | "locationWeights"> &
  Partial<Pick<ProfilePrefs, "homeCountry" | "markets">>;

/** ISO-2 home country: explicit → currency → location-pref labels → "" (unknown). */
export function effectiveHomeCountry(prefs: RegionPrefs): string {
  const explicit = (prefs.homeCountry ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  const byCurrency = CURRENCY_HOME[(prefs.currency ?? "").trim().toUpperCase()];
  if (byCurrency) return byCurrency;
  // the highest-weighted label that names a place decides (ties: listed first)
  const labels = [...(prefs.locationWeights ?? [])]
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.weight - a.w.weight || a.i - b.i);
  for (const { w } of labels) {
    const code = countryCodeFromText(w.label);
    if (code) return code;
  }
  return "";
}

/** ISO-2 markets to search: explicit markets, else [home], else []. */
export function effectiveMarkets(prefs: RegionPrefs): string[] {
  const markets = (prefs.markets ?? []).map((m) => m.trim().toUpperCase()).filter((m) => /^[A-Z]{2}$/.test(m));
  if (markets.length) return [...new Set(markets)];
  const home = effectiveHomeCountry(prefs);
  return home ? [home] : [];
}

/** remote geos open to the user: their own `remoteGeoOk` plus what's open from home. */
export function effectiveRemoteGeos(prefs: RegionPrefs & Pick<ProfilePrefs, "remoteGeoOk">): RemoteGeo[] {
  const home = effectiveHomeCountry(prefs);
  return [...new Set<RemoteGeo>([...(prefs.remoteGeoOk ?? []), ...(home ? remoteGeosForCountry(home) : [])])];
}
