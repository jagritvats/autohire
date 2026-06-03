import type { ParsedLocation } from "../schema/entities.js";
import type { LocationMode, RemoteGeo } from "../schema/enums.js";

/**
 * Location parsing (§11.3) — the false-positive minefield. The high-value move
 * is detecting geo-restricted "remote": a role tagged remote that's actually
 * remote-US-only. Heuristic here; the matcher can escalate to an LLM extraction
 * pass on ambiguous JDs.
 */

const INDIA_CITIES = /\b(bengaluru|bangalore|mumbai|pune|hyderabad|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|india)\b/i;
const US_HINT = /\b(united states|\busa\b|\bus\b|new york|san francisco|\bsf\b|seattle|austin|remote[ -]?us|us[ -]?based|us remote)\b/i;
const EU_HINT = /\b(europe|\beu\b|germany|berlin|london|\buk\b|united kingdom|amsterdam|paris|emea)\b/i;

const REMOTE_RE = /\bremote\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[ -]?site|in[ -]?office|in[ -]?person)\b/i;

// geo-restriction phrases on "remote" roles
const US_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(us|usa|united states)|us[ -]?only|must (be|reside).{0,20}(united states|us)|us work authorization|authorized to work in the us|eligible to work in the (us|united states))\b/i;
const EU_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(eu|europe|emea)|eu[ -]?only|must (be|reside).{0,20}(europe|eu))\b/i;
const INDIA_OK_RE = /\b(remote[ ,-]*india|india[ -]?(based|remote)|anywhere in india)\b/i;
const WORLDWIDE_RE = /\b(remote[ ,-]*(anywhere|worldwide|global)|work from anywhere|fully remote)\b/i;

const SPONSORSHIP_NEG = /\b(no (visa )?sponsorship|not (able|eligible) to sponsor|do not (provide|offer) sponsorship|without sponsorship)\b/i;
const SPONSORSHIP_POS = /\b(visa sponsorship|will sponsor|relocation (provided|assistance|support)|sponsorship available)\b/i;

const TZ_HINTS: Array<[RegExp, string]> = [
  [/\b(ist|india standard time)\b/i, "Asia/Kolkata"],
  [/\b(pst|pdt|pacific)\b/i, "America/Los_Angeles"],
  [/\b(est|edt|eastern)\b/i, "America/New_York"],
  [/\b(cet|cest|central european)\b/i, "Europe/Berlin"],
  [/\b(gmt|utc)\b/i, "UTC"],
];

export function parseLocation(locationRaw: string | null, jdText = ""): ParsedLocation {
  const loc = (locationRaw ?? "").trim();
  const haystack = `${loc} ${jdText}`;

  // 1. mode
  let mode: LocationMode = "unknown";
  if (REMOTE_RE.test(haystack)) mode = "remote";
  if (HYBRID_RE.test(haystack)) mode = "hybrid";
  if (mode === "unknown" && ONSITE_RE.test(haystack)) mode = "onsite";
  if (mode === "unknown" && loc) mode = "onsite"; // a bare city name implies onsite

  // 2. country/city
  const country = INDIA_CITIES.test(loc)
    ? "India"
    : US_HINT.test(loc)
      ? "United States"
      : EU_HINT.test(loc)
        ? "Europe"
        : null;
  const cityMatch = loc.match(INDIA_CITIES) ?? loc.match(/\b([A-Z][a-zA-Z]+)(?:,|\s|$)/);
  const city = cityMatch ? cityMatch[0].replace(/,$/, "").trim() : null;

  // 3. remote geo — the load-bearing signal (§11.3)
  let remoteGeo: RemoteGeo = "unknown";
  if (mode === "remote") {
    if (WORLDWIDE_RE.test(haystack)) remoteGeo = "worldwide";
    if (INDIA_OK_RE.test(haystack) || INDIA_CITIES.test(loc)) remoteGeo = "india_ok";
    if (US_ONLY_RE.test(haystack)) remoteGeo = "us_only";
    else if (EU_ONLY_RE.test(haystack)) remoteGeo = "eu_only";
    // a "remote" role whose only geo hint is US, with no india/worldwide signal → likely us_only
    if (remoteGeo === "unknown" && US_HINT.test(haystack) && !INDIA_CITIES.test(haystack)) {
      remoteGeo = "us_only";
    }
  }

  // 4. timezone
  let timezone: string | null = null;
  for (const [re, tz] of TZ_HINTS) {
    if (re.test(haystack)) {
      timezone = tz;
      break;
    }
  }
  if (!timezone && country === "India") timezone = "Asia/Kolkata";

  // 5. sponsorship
  const sponsorship = SPONSORSHIP_NEG.test(jdText)
    ? false
    : SPONSORSHIP_POS.test(jdText)
      ? true
      : null;

  return { mode, city, country, timezone, remoteGeo, sponsorship };
}
