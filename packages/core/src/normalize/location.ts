import type { ParsedLocation } from "../schema/entities.js";
import type { LocationMode, RemoteGeo } from "../schema/enums.js";

/**
 * Location parsing (§11.3) — the false-positive minefield. The high-value move
 * is detecting geo-restricted "remote": a role tagged remote that's actually
 * remote-US-only. Heuristic here; the matcher can escalate to an LLM extraction
 * pass on ambiguous JDs.
 *
 * Precedence: the source's LOCATION string is the structured claim and wins; JD
 * prose only fills gaps. Prose is full of "remote-friendly perks" and "join us",
 * which must not flip an onsite Bengaluru role to remote or a remote role to US-only.
 */

const INDIA_CITIES = /\b(bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|secunderabad|delhi|new delhi|ncr|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|gandhinagar|gift city|vadodara|jaipur|indore|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|mysore|mysuru|mangalore|mangaluru|chandigarh|mohali|bhubaneswar|visakhapatnam|vizag|nagpur|lucknow|india)\b/i;
/** US signal in a LOCATION string (short, structured) — case-insensitive is safe here. */
const US_HINT = /\b(united states|usa|u\.s\.a?\.?|us|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|palo alto|mountain view|menlo park|sunnyvale|san jose|san mateo|redwood city|oakland|portland|dallas|houston|philadelphia|pittsburgh|washington,? d\.?c\.?|remote[ -]?us|us[ -]?based|bellevue|redmond|kirkland|santa clara|cupertino|san diego|irvine|nashville|raleigh|durham|charlotte|phoenix|tempe|salt lake city|minneapolis|detroit|columbus|st\.? louis|kansas city|baltimore|arlington|reston|herndon|mclean|plano|irving|jersey city|hoboken|honolulu|pleasanton|schenectady|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b|,\s*(CA|NY|WA|TX|MA|IL|CO|GA|FL|OR|UT|NC|VA|NJ|PA|AZ|MN|MI|OH|DC)\b|\bUS-[A-Z]{2}\b/i;
const CANADA_HINT = /\b(canada|toronto|vancouver|montreal|ottawa|calgary|waterloo|edmonton|ontario|quebec|british columbia|alberta|manitoba|nova scotia)\b/i;
/** Region-level restrictions that are NOT open to someone in India (Americas-only). */
const AMERICAS_HINT = /\b(north america|americas|latam|latin america|canada)\b/i;
/** a multi-country Americas region (Canada alone is a country — `geoFromLoc`) */
const AMERICAS_REGION = /\b(north america|americas|latam|latin america)\b/i;
/**
 * ASCII-fold a place string so "München", "Köln", "Zürich", "København", "Wrocław",
 * "Genève" and "Österreich" match the same patterns as their plain spellings. NFD strips
 * combining accents; ø / æ / ß / ł / đ / ı don't decompose, so they're mapped by hand.
 */
export function foldPlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o")
    .replace(/Ø/g, "O")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "AE")
    .replace(/ß/g, "ss")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/ı/g, "i");
}

/**
 * European places by ISO-2 (§11.3): country names (English and local, matched on the
 * `foldPlace`d string) and cities. Names and cities are kept apart so a segment that NAMES
 * its country ("Durham, United Kingdom") isn't overruled by a city word that also exists
 * elsewhere. Left out on purpose: names that are common US places too (Cambridge,
 * Birmingham, Hanover, Florence, Bergen, York) and plain words (Nice, Split, Reading, Bath).
 */
const EUROPE_PLACES: ReadonlyArray<readonly [code: string, names: RegExp, cities: RegExp | null]> = [
  ["GB", /\b(united kingdom|uk|great britain|britain|england|scotland|wales|northern ireland)\b/i, /\b(london|manchester|edinburgh|glasgow|bristol|oxford|leeds|liverpool|newcastle upon tyne|belfast|cardiff|sheffield|nottingham|brighton|milton keynes|guildford|aberdeen|southampton|leicester|coventry)\b/i],
  ["IE", /\b((?<!northern )ireland|eire)\b/i, /\b(dublin|cork|galway|limerick|waterford)\b/i],
  ["DE", /\b(germany|deutschland)\b/i, /\b(berlin|munich|munchen|muenchen|hamburg|frankfurt|cologne|koln|koeln|stuttgart|dusseldorf|duesseldorf|leipzig|dresden|nuremberg|nurnberg|nuernberg|hannover|bonn|karlsruhe|mannheim|heidelberg|dortmund|bremen|potsdam|freiburg|aachen|darmstadt|wiesbaden|mainz|walldorf|ingolstadt|wolfsburg|erlangen)\b/i],
  ["NL", /\b(netherlands|nederland|holland)\b/i, /\b(amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|delft|leiden|groningen|haarlem|amstelveen|hilversum|nijmegen|arnhem|breda|tilburg|enschede)\b/i],
  ["FR", /\b(france)\b/i, /\b(paris|lyon|marseille|toulouse|nantes|bordeaux|lille|grenoble|montpellier|rennes|strasbourg|sophia antipolis)\b/i],
  ["ES", /\b(spain|espana)\b/i, /\b(madrid|barcelona|valencia|seville|sevilla|malaga|bilbao|zaragoza)\b/i],
  ["PT", /\b(portugal)\b/i, /\b(lisbon|lisboa|porto(?! alegre)|braga|coimbra|aveiro)\b/i],
  ["PL", /\b(poland|polska)\b/i, /\b(warsaw|warszawa|krakow|cracow|wroclaw|gdansk|poznan|lodz|katowice|gdynia|szczecin|lublin)\b/i],
  ["IT", /\b(italy|italia)\b/i, /\b(milan|milano|rome|roma|turin|torino|naples|napoli|firenze|bologna|genoa|genova|venezia|padova|trieste)\b/i],
  ["SE", /\b(sweden|sverige)\b/i, /\b(stockholm|gothenburg|goteborg|malmo|uppsala|linkoping)\b/i],
  ["DK", /\b(denmark|danmark)\b/i, /\b(copenhagen|kobenhavn|aarhus|odense|aalborg)\b/i],
  ["FI", /\b(finland|suomi)\b/i, /\b(helsinki|espoo|tampere|oulu|turku|vantaa)\b/i],
  ["NO", /\b(norway|norge)\b/i, /\b(oslo|trondheim|stavanger)\b/i],
  ["AT", /\b(austria|osterreich|oesterreich)\b/i, /\b(vienna|wien|graz|linz|salzburg|innsbruck)\b/i],
  ["BE", /\b(belgium|belgique|belgie)\b/i, /\b(brussels|bruxelles|brussel|antwerp|antwerpen|ghent|gent|leuven|liege|mechelen)\b/i],
  ["CH", /\b(switzerland|schweiz|suisse|svizzera)\b/i, /\b(zurich|zuerich|geneva|geneve|genf|basel|bern|lausanne|lugano|zug|winterthur)\b/i],
  ["CZ", /\b(czechia|czech republic|cesko|ceska republika)\b/i, /\b(prague|praha|brno|ostrava)\b/i],
  ["RO", /\b(romania)\b/i, /\b(bucharest|bucuresti|cluj|iasi|timisoara|brasov)\b/i],
  ["GR", /\b(greece)\b/i, /\b(athens|thessaloniki)\b/i],
  ["HU", /\b(hungary|magyarorszag)\b/i, /\b(budapest|debrecen)\b/i],
  ["LU", /\b(luxembourg)\b/i, null],
  ["EE", /\b(estonia|eesti)\b/i, /\b(tallinn|tartu)\b/i],
  ["LV", /\b(latvia)\b/i, /\b(riga)\b/i],
  ["LT", /\b(lithuania)\b/i, /\b(vilnius|kaunas)\b/i],
  ["SK", /\b(slovakia|slovensko)\b/i, /\b(bratislava|kosice)\b/i],
  ["SI", /\b(slovenia)\b/i, /\b(ljubljana)\b/i],
  ["HR", /\b(croatia|hrvatska)\b/i, /\b(zagreb)\b/i],
  ["BG", /\b(bulgaria)\b/i, /\b(sofia|plovdiv|varna)\b/i],
  ["IS", /\b(iceland)\b/i, /\b(reykjavik)\b/i],
  ["UA", /\b(ukraine)\b/i, /\b(kyiv|kiev|lviv|kharkiv|odesa|odessa|dnipro)\b/i],
  ["RS", /\b(serbia)\b/i, /\b(belgrade|beograd|novi sad)\b/i],
  ["CY", /\b(cyprus)\b/i, /\b(limassol|nicosia|larnaca)\b/i],
  ["MT", /\b(malta)\b/i, /\b(valletta|sliema)\b/i],
];
/** a pan-European region word (no single country). */
const EU_REGION = /\b(europe|european union|eu|emea)\b/i;
/** any European place or region word in a location string (diacritic-insensitive). */
const EU_HINT = {
  test(s: string): boolean {
    const f = foldPlace(s);
    return EU_REGION.test(f) || EUROPE_PLACES.some(([, names, cities]) => names.test(f) || !!cities?.test(f));
  },
};
const APAC_HINT = /\b(apac|asia[- ]pacific|asia)\b/i;

/**
 * Countries the region hints above don't cover, named by the display name `parseLocation`
 * reports. Without them an onsite Tokyo / Singapore / São Paulo role had no country — never
 * "abroad", so never discounted or flagged for a user in India or the US (audit 2026-11:
 * 13–19% of onsite postings).
 */
const OTHER_COUNTRIES: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["SG", "Singapore", /\bsingapore\b/i],
  ["JP", "Japan", /\b(japan|tokyo|osaka|yokohama|kyoto|fukuoka)\b/i],
  ["KR", "South Korea", /\b(south korea|korea|seoul|busan|pangyo)\b/i],
  ["AU", "Australia", /\b(australia|sydney|melbourne|brisbane|perth|canberra|adelaide)\b/i],
  ["NZ", "New Zealand", /\b(new zealand|auckland|wellington)\b/i],
  ["CN", "China", /\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou|chengdu)\b/i],
  ["HK", "Hong Kong", /\bhong kong\b/i],
  ["TW", "Taiwan", /\b(taiwan|taipei|hsinchu)\b/i],
  ["PH", "Philippines", /\b(philippines|manila|makati|taguig|cebu)\b/i],
  ["MY", "Malaysia", /\b(malaysia|kuala lumpur|penang)\b/i],
  ["TH", "Thailand", /\b(thailand|bangkok)\b/i],
  ["ID", "Indonesia", /\b(indonesia|jakarta)\b/i],
  ["VN", "Vietnam", /\b(vietnam|viet nam|ho chi minh|hanoi)\b/i],
  ["AE", "United Arab Emirates", /\b(united arab emirates|uae|dubai|abu dhabi)\b/i],
  ["SA", "Saudi Arabia", /\b(saudi arabia|ksa|riyadh|jeddah)\b/i],
  ["QA", "Qatar", /\b(qatar|doha)\b/i],
  ["KW", "Kuwait", /\bkuwait\b/i],
  ["EG", "Egypt", /\b(egypt|cairo)\b/i],
  ["IL", "Israel", /\b(israel|tel aviv|herzliya|haifa|jerusalem)\b/i],
  ["TR", "Turkey", /\b(turkey|türkiye|turkiye|istanbul|ankara)\b/i],
  ["ZA", "South Africa", /\b(south africa|johannesburg|cape town)\b/i],
  ["NG", "Nigeria", /\b(nigeria|lagos)\b/i],
  ["KE", "Kenya", /\b(kenya|nairobi)\b/i],
  ["MX", "Mexico", /\b((?<!new )mexico|guadalajara|monterrey)\b/i],
  ["BR", "Brazil", /\b(brazil|brasil|s[aã]o paulo|rio de janeiro|curitiba|florian[oó]polis|belo horizonte)\b/i],
  ["AR", "Argentina", /\b(argentina|buenos aires)\b/i],
  ["CO", "Colombia", /\b(colombia|bogot[aá]|medell[ií]n)\b/i],
  ["CL", "Chile", /\bchile\b/i],
  ["PE", "Peru", /\bperu\b/i],
  ["CR", "Costa Rica", /\bcosta rica\b/i],
  ["UY", "Uruguay", /\b(uruguay|montevideo)\b/i],
  ["DO", "Dominican Republic", /\bdominican republic\b/i],
  ["PK", "Pakistan", /\b(pakistan|karachi|lahore|islamabad)\b/i],
  ["BD", "Bangladesh", /\b(bangladesh|dhaka)\b/i],
  ["LK", "Sri Lanka", /\b(sri lanka|colombo)\b/i],
];

function otherCountry(loc: string): (typeof OTHER_COUNTRIES)[number] | null {
  const f = foldPlace(loc);
  for (const row of OTHER_COUNTRIES) if (row[2].test(f)) return row;
  return null;
}

// ── every place a location string names (multi-office / multi-city postings) ──

/**
 * Separators between places in one location string: Greenhouse offices, Workday's joined
 * locations and most ATS adapters emit "A; B"; others use "|", " / ", " · ", a newline, or
 * " or " / " and " / " & " ("Remote - US or Canada"). Commas are NOT separators: they
 * qualify a place ("Austin, TX, United States"). "or"/"and" are matched lower-case only so
 * a state code ("Salem, OR") isn't read as a separator.
 */
const PLACE_SEPARATOR = /\s*(?:[;|\n•]|\s\/\s|\s·\s|\s+(?:or|and|&)\s+)\s*/;
const US_NAME = /\b(united states|usa|us)\b|\bu\.s\.(?:a\.)?/i;
const CANADA_NAME = /\bcanada\b/i;
/** "Dublin, OH", "Paris, TX", "US-CA": a US state code beats a same-named European city. */
const US_STATE_SUFFIX = /,\s*(CA|NY|WA|TX|MA|IL|CO|GA|FL|OR|UT|NC|VA|NJ|PA|AZ|MN|MI|OH|DC)\b|\bUS-[A-Z]{2}\b/;

/**
 * ISO-2 codes for ONE place ("Austin, TX", "London, United Kingdom", "München"). A segment
 * that names countries returns all of them ("USA, Canada", "Germany, Austria"); otherwise
 * the first city-level match in a fixed precedence (India, US state code, Canada, Europe,
 * other US hints, the rest of the world) decides one country.
 */
function placeCodes(segment: string): string[] {
  const s = foldPlace(segment);
  if (!s.trim()) return [];
  if (INDIA_CITIES.test(s)) return ["IN"];
  const named: string[] = [];
  if (US_NAME.test(s)) named.push("US");
  if (CANADA_NAME.test(s)) named.push("CA");
  for (const [code, names] of EUROPE_PLACES) if (names.test(s)) named.push(code);
  // a list naming several countries ("Remote Europe, USA, Canada, Australia, Singapore")
  // keeps every one; the rest of the world only joins a list that already names a country
  if (named.length) {
    for (const [code, , re] of OTHER_COUNTRIES) if (re.test(s)) named.push(code);
    return named;
  }
  if (US_STATE_SUFFIX.test(s)) return ["US"];
  if (CANADA_HINT.test(s)) return ["CA"];
  for (const [code, , cities] of EUROPE_PLACES) if (cities?.test(s)) return [code];
  if (US_HINT.test(s)) return ["US"];
  const other = otherCountry(s);
  return other ? [other[0]] : [];
}

/** ISO-2 code for the country NAME `parseLocation` reports (null for "Europe" / unknown). */
function codeForParsedCountry(name: string | null | undefined): string | null {
  if (!name || name === "Europe") return null;
  for (const [code, n] of Object.entries(PARSED_COUNTRY_NAME)) if (n === name) return code;
  return null;
}

/**
 * Every country a location string places the role in, as ISO-2, primary first. A
 * multi-office posting ("Hybrid - Austin, TX; London, United Kingdom") is workable in each.
 */
export function locationCountries(locationRaw: string | null | undefined, primary?: string | null): string[] {
  const loc = (locationRaw ?? "").replace(/\bUS-[A-Z]{2}-[^;,|]*/g, "US");
  const out: string[] = [];
  const first = codeForParsedCountry(primary);
  if (first) out.push(first);
  for (const seg of loc.split(PLACE_SEPARATOR)) for (const c of placeCodes(seg)) if (!out.includes(c)) out.push(c);
  return out;
}

/** Ashby-style "US-CA-Menlo Park", "JP-Tokyo", "Fins Only-AU-Sydney-MSO", "6 Locations" → the place words. */
function cleanForCity(loc: string): string {
  return loc
    .replace(/\b\d+\s+locations?\b/gi, " ")
    .replace(/\b(?:fins only|n\/a|multiple locations|various locations|locations?)\b/gi, " ")
    .replace(/\b[A-Z]{2}-\s?(?:[A-Z]{2}-)?(?=[A-Z])/g, "")
    .replace(/-(?:remote|mso|observe|office|hq)\b/gi, " ")
    .replace(/\b(?:hq|office|campus)\b/gi, " ");
}

/**
 * US signal in free JD TEXT. The location-string regex above can't be reused: run
 * case-insensitively over prose, `\bus\b` matches the pronoun ("join us", "contact
 * us") and turned most remote JDs into false "US-only" (§11.3). Here "US" must be
 * upper-case and not part of an all-caps heading like "ABOUT US" / "JOIN US".
 */
const US_TEXT_CS = /(?<!\b(?:ABOUT|JOIN|CONTACT|WITH|OF|TO|FOR|HELP|LET|BY|AT|FROM|ON)\s)\b(US|USA|U\.S\.(?:A\.)?)(?![A-Za-z])/;
const US_TEXT_CI = /\b(united states|us[ -]based|based in the us|us time ?zones?|continental us)\b/i;
function usTextSignal(text: string): boolean {
  return US_TEXT_CS.test(text) || US_TEXT_CI.test(text);
}

const REMOTE_RE = /\bremote\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[ -]?site|in[ -]?office|in[ -]?person|work from office|wfo)\b/i;
/** JD phrasing that says the ROLE itself is remote (vs a "remote-friendly" / "WFH stipend" perk). */
const ROLE_REMOTE_RE = /\b(fully remote|100% remote|remote role|remote position|this (role|position|job) is (fully )?remote|work from anywhere)\b/i;
/** looser — only used when the posting gave no location at all. */
const STRONG_REMOTE_RE = /\b(fully remote|100% remote|remote[- ]first|remote role|remote position|work from anywhere|work from home|wfh|this role is remote)\b/i;

// geo-restriction phrases on "remote" roles
const US_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(us|usa|united states)|us[ -]?only|usa[ -]?only|must (be|reside|live).{0,30}(united states|\bus\b|usa)|(located|based|reside) in the (us|united states)|us work authorization|authorized to work in the (us|united states)|eligible to work in the (us|united states)|us citizens?(hip)?|green card|us persons?|w-?2 (only|employees?))\b/i;
const EU_ONLY_RE = /\b(remote[ ,-]*(within )?(the )?(eu|europe|emea|uk)|eu[ -]?only|uk[ -]?only|must (be|reside|live).{0,30}(europe|\beu\b|\buk\b)|right to work in the (uk|eu))\b/i;
const INDIA_OK_RE = /\b(remote[ ,-]*\(?india|india[ -]?(based|remote)|anywhere in india|remote,? india|pan[ -]india|open to (candidates in )?india|work from home.{0,20}india)\b/i;
/**
 * JD phrasing that opens a remote ROLE to the world. Not a bare "worldwide": that is company
 * boilerplate ("customers worldwide", "offices worldwide") and made restricted roles read as
 * worldwide at 0.9 confidence (audit 2026-11: "Remote - California" → worldwide).
 */
const WORLDWIDE_RE = /\b(remote[ ,-]*\(?(anywhere|worldwide|global)|work from anywhere|anywhere in the world|(fully |100% )?remote[^.\n]{0,25}\b(worldwide|globally)|hire (from )?anywhere|globally remote|location[- ]independent)\b/i;

const SPONSORSHIP_NEG = /(no (visa )?sponsorship|not (able|eligible) to sponsor|(do|does|will|can) ?n[o']t (provide|offer|sponsor)[^.]{0,20}sponsor|without sponsorship|unable to sponsor|cannot sponsor)/i;
const SPONSORSHIP_POS = /\b(visa sponsorship|will sponsor|relocation (provided|assistance|support|package)|sponsorship available)\b/i;

const TZ_HINTS: Array<[RegExp, string]> = [
  [/\b(ist|india standard time)\b/i, "Asia/Kolkata"],
  [/\b(pst|pdt|pacific time)\b/i, "America/Los_Angeles"],
  [/\b(est|edt|eastern time)\b/i, "America/New_York"],
  [/\b(cet|cest|central european)\b/i, "Europe/Berlin"],
  [/\b(gmt|utc)\b/i, "UTC"],
];

/** Where the remote geo came from — drives the honest confidence below (§11.3). */
type GeoSource = "loc" | "loc_country" | "jd_explicit" | "jd_inferred" | "none";

/**
 * Remote geo from the LOCATION string (Remotive's candidate_required_location, Ashby's
 * "Remote - India", HN's "Remote (US)"). India/worldwide win over a co-listed
 * restriction because a multi-location string ("US; India") means India is an option.
 */
function geoFromLoc(loc: string): RemoteGeo | null {
  if (!loc) return null;
  if (INDIA_CITIES.test(loc)) return "india_ok";
  if (/\b(anywhere|worldwide|global|international)\b/i.test(loc)) return "worldwide";
  if (APAC_HINT.test(loc)) return "apac_ok";
  // Canada ALONE is one country, not the Americas: filed under us_only it read as open to a
  // US resident (Affirm's separate "Remote - Canada" reqs ranked top-20 for a US profile).
  // It stays a single-country remote (see parseLocation); "US or Canada" is still us_only.
  const us = US_HINT.test(loc) || AMERICAS_REGION.test(loc);
  const eu = EU_HINT.test(loc);
  if (us && eu) return "us_eu";
  if (us) return "us_only";
  if (eu) return "eu_only";
  return null;
}

export function parseLocation(locationRaw: string | null, jdText = ""): ParsedLocation {
  const raw = (locationRaw ?? "").trim();
  // hints read "US-CA-Dublin" as the US, not as Dublin, Ireland (Ashby's ISO-prefixed form)
  const loc = raw.replace(/\bUS-[A-Z]{2}-[^;,|]*/g, "US");
  const jd = jdText ?? "";

  // 1. mode — location string first; JD prose only fills a gap
  let mode: LocationMode = "unknown";
  if (HYBRID_RE.test(loc)) mode = "hybrid";
  else if (REMOTE_RE.test(loc)) mode = "remote";
  else if (ONSITE_RE.test(loc)) mode = "onsite";
  if (mode === "unknown") {
    if (HYBRID_RE.test(jd)) mode = "hybrid";
    else if (loc) mode = ROLE_REMOTE_RE.test(jd) ? "remote" : "onsite"; // a bare city implies onsite
    else if (STRONG_REMOTE_RE.test(jd)) mode = "remote";
    else if (REMOTE_RE.test(jd)) mode = "remote";
    else if (ONSITE_RE.test(jd)) mode = "onsite";
  }

  // 2. country/city (from the location string only)
  const country = INDIA_CITIES.test(loc)
    ? "India"
    : US_HINT.test(loc)
      ? "United States"
      : CANADA_HINT.test(loc)
        ? "Canada"
        : EU_HINT.test(loc)
          ? "Europe"
          : (otherCountry(loc)?.[1] ?? null);
  const locForCity = cleanForCity(raw).replace(/\b(remote|hybrid|on[ -]?site|in[ -]?office|anywhere|worldwide|global)\b/gi, " ");
  // up to three capitalised words ending at a separator: "San Francisco, CA", "New York
  // City", "Tel Aviv" — not just their first word. Unicode letters, so "München" and
  // "Kraków" are whole words, not "M" / "Krak".
  const cityMatch =
    locForCity.match(INDIA_CITIES) ??
    locForCity.match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}.'-]+(?:\s+\p{Lu}[\p{L}.'-]+){0,2}(?=\s*(?:[,(|/;]|\s-\s|$))/u) ??
    locForCity.match(/(?<![\p{L}\p{N}])(\p{Lu}\p{L}+)(?:,|\s|$)/u);
  const city = cityMatch ? cityMatch[0].replace(/,$/, "").trim() : null;
  // every country the string names (primary first): a multi-office role is workable in each
  const countries = locationCountries(raw, country);

  // 3. remote geo — the load-bearing signal (§11.3)
  const indiaSignal = INDIA_OK_RE.test(jd) || INDIA_CITIES.test(loc);
  const usSignal = US_HINT.test(loc) || AMERICAS_HINT.test(loc) || usTextSignal(jd) || US_ONLY_RE.test(jd);
  const euSignal = EU_HINT.test(loc) || EU_ONLY_RE.test(jd);
  let remoteGeo: RemoteGeo = "unknown";
  let geoSource: GeoSource = "none";
  if (mode === "remote") {
    const fromLoc = geoFromLoc(loc);
    if (fromLoc) {
      remoteGeo = fromLoc;
      geoSource = "loc";
    } else if (country && (country === "Canada" || otherCountry(loc))) {
      // "Remote - Brazil": remote WITHIN one named country. No RemoteGeo names it, so the geo
      // stays unknown, but the country is a structured claim — JD boilerplate ("customers
      // worldwide", a stray "US") must not reinterpret it.
      geoSource = "loc_country";
    }
    // an explicit JD restriction beats a generic "worldwide" label, never a named India option
    if ((remoteGeo === "unknown" || remoteGeo === "worldwide") && geoSource !== "loc_country") {
      if (US_ONLY_RE.test(jd)) {
        remoteGeo = "us_only";
        geoSource = "jd_explicit";
      } else if (EU_ONLY_RE.test(jd)) {
        remoteGeo = "eu_only";
        geoSource = "jd_explicit";
      }
    }
    if (remoteGeo === "unknown" && geoSource !== "loc_country") {
      if (INDIA_OK_RE.test(jd)) remoteGeo = "india_ok";
      else if (WORLDWIDE_RE.test(jd)) remoteGeo = "worldwide";
      else if (/\b(apac|asia[- ]pacific)\b/i.test(jd)) remoteGeo = "apac_ok";
      if (remoteGeo !== "unknown") geoSource = "jd_explicit";
    }
    // a "remote" role whose only geo hint is US, with no india/worldwide signal → likely us_only
    if (remoteGeo === "unknown" && geoSource !== "loc_country" && usSignal && !INDIA_CITIES.test(`${loc} ${jd}`)) {
      remoteGeo = "us_only";
      geoSource = "jd_inferred";
    }
  }

  // 4. timezone
  const haystack = `${loc} ${jd}`;
  let timezone: string | null = null;
  for (const [re, tz] of TZ_HINTS) {
    if (re.test(haystack)) {
      timezone = tz;
      break;
    }
  }
  if (!timezone && country === "India") timezone = "Asia/Kolkata";

  // 5. sponsorship
  const sponsorship = SPONSORSHIP_NEG.test(jd)
    ? false
    : SPONSORSHIP_POS.test(jd)
      ? true
      : null;

  // 6. confidence (§11.3) — how much we trust the geo we just parsed. Be honest:
  //    a lone stray "US" hint on a "remote" role, or a bare capitalized token with
  //    no resolvable country, is a guess and must NOT read as fact downstream.
  const conflicting = [indiaSignal, usSignal, euSignal].filter(Boolean).length > 1;
  const confidence = scoreConfidence(mode, country, city, remoteGeo, geoSource, conflicting);

  return { mode, city, country, ...(countries.length ? { countries } : {}), timezone, remoteGeo, sponsorship, confidence };
}

/** Deterministic 0..1 confidence for the parsed geo (§11.3). */
function scoreConfidence(
  mode: LocationMode,
  country: string | null,
  city: string | null,
  remoteGeo: RemoteGeo,
  geoSource: GeoSource,
  conflicting: boolean,
): number {
  if (mode === "remote") {
    // the location field is a structured claim; JD prose disagreeing with it lowers trust
    if (geoSource === "loc") return conflicting && remoteGeo !== "india_ok" ? 0.6 : 0.9;
    if (geoSource === "loc_country") return 0.8; // the country is stated; no RemoteGeo names it
    if (conflicting) return 0.4; // multiple, competing geo hints — unsure which binds
    if (geoSource === "jd_explicit") return remoteGeo === "worldwide" || remoteGeo === "india_ok" ? 0.9 : 0.85;
    if (remoteGeo === "unknown") return 0.35; // "remote" with zero geo info
    return 0.5; // us_only INFERRED from a lone hint — a soft guess, flag it
  }
  if (mode === "hybrid" || mode === "onsite") {
    if (country && city) return 0.85; // explicit city + resolvable country
    if (country) return 0.7;
    if (city) return 0.45; // a capitalized token, but no country we recognize
    return 0.3; // bare / ambiguous
  }
  return 0.2; // mode unknown, nothing resolved
}

/**
 * India-workable = onsite/hybrid in India, OR remote that's open to India
 * (`india_ok` / `worldwide`). Used by the "India-onsite allowed" view filter and
 * as a soft ranking signal — never a hard filter (invariant #4). The India case of the
 * region-neutral `isWorkableIn` (identical results).
 */
export function isIndiaWorkable(loc: ParsedLocation): boolean {
  return isWorkableIn(loc, ["IN"]);
}

// ── region-neutral helpers (home country / markets are ISO-3166 alpha-2) ──

/** ISO-2 → the country NAME `parseLocation` reports in `ParsedLocation.country`. */
export const PARSED_COUNTRY_NAME: Readonly<Record<string, string>> = {
  IN: "India",
  US: "United States",
  CA: "Canada",
  ...Object.fromEntries(OTHER_COUNTRIES.map(([code, name]) => [code, name])),
};

/**
 * Countries the parser only resolves to the region "Europe" (it names no European
 * country). A European home/market vs a "Europe" posting is the right REGION with an
 * unknown country — never "definitely abroad".
 */
export const EUROPE_CODES: ReadonlySet<string> = new Set([
  "GB", "IE", "DE", "NL", "FR", "ES", "PT", "PL", "IT", "SE", "DK", "FI", "NO", "AT", "BE", "CH",
  "CZ", "RO", "GR", "HU", "LU", "EE", "LV", "LT", "SK", "SI", "HR", "BG", "IS", "UA", "RS", "CY", "MT",
]);
const AMERICAS_CODES: ReadonlySet<string> = new Set(["CA", "MX", "BR", "AR", "CL", "CO", "PE", "UY", "CR"]);
const APAC_CODES: ReadonlySet<string> = new Set(["SG", "AU", "NZ", "JP", "KR", "HK", "TW", "PH", "MY", "ID", "VN", "TH"]);

/**
 * Remote geos OPEN to someone living in a country — "remote, eligible from here" per
 * market. Explicit rows win; other countries fall back by region. IN matches
 * `isIndiaWorkable` exactly. The Americas include `us_only` because the parser files
 * "North America" / "Canada" / "LATAM" restrictions under it: a US-only role can't be told
 * from a Canada-ok one, so it is never treated as closed (soft signal, invariant #4).
 */
export const REMOTE_GEOS_FOR_COUNTRY: Readonly<Record<string, readonly RemoteGeo[]>> = {
  IN: ["india_ok", "worldwide"],
  US: ["us_only", "us_eu", "worldwide"],
};

export function remoteGeosForCountry(code: string): RemoteGeo[] {
  const c = code.trim().toUpperCase();
  if (!c) return [];
  const row = REMOTE_GEOS_FOR_COUNTRY[c];
  if (row) return [...row];
  if (EUROPE_CODES.has(c)) return ["eu_only", "us_eu", "worldwide"];
  if (AMERICAS_CODES.has(c)) return ["us_only", "worldwide"];
  if (APAC_CODES.has(c)) return ["apac_ok", "worldwide"];
  return ["worldwide"];
}

/** the remote geo that means "named for this country" (india_ok for IN …), or null. */
export function primaryRemoteGeo(code: string): RemoteGeo | null {
  const c = code.trim().toUpperCase();
  if (c === "IN") return "india_ok";
  if (c === "US") return "us_only";
  if (EUROPE_CODES.has(c)) return "eu_only";
  if (APAC_CODES.has(c)) return "apac_ok";
  return null;
}

/** display name for an ISO-2 code (the parser's name where it has one). */
export function countryDisplayName(code: string): string {
  const c = code.trim().toUpperCase();
  return PARSED_COUNTRY_NAME[c] ?? COUNTRY_DISPLAY[c] ?? c;
}
const COUNTRY_DISPLAY: Record<string, string> = {
  GB: "United Kingdom", DE: "Germany", NL: "Netherlands", FR: "France", IE: "Ireland", ES: "Spain",
  PT: "Portugal", PL: "Poland", SE: "Sweden", CH: "Switzerland", SG: "Singapore", AU: "Australia",
  NZ: "New Zealand", JP: "Japan", AE: "United Arab Emirates",
  IT: "Italy", DK: "Denmark", FI: "Finland", NO: "Norway", AT: "Austria", BE: "Belgium", CZ: "Czechia",
  RO: "Romania", GR: "Greece", HU: "Hungary", LU: "Luxembourg", EE: "Estonia", LV: "Latvia",
  LT: "Lithuania", SK: "Slovakia", SI: "Slovenia", HR: "Croatia", BG: "Bulgaria", IS: "Iceland",
  UA: "Ukraine", RS: "Serbia", CY: "Cyprus", MT: "Malta",
};

/**
 * Does a parsed posting country match an ISO-2 country? `true` = definitely there,
 * `false` = definitely elsewhere, `null` = can't tell (no country parsed, or only the
 * region "Europe" for a European country).
 */
export function parsedCountryMatches(parsed: string | null | undefined, code: string): boolean | null {
  const c = code.trim().toUpperCase();
  if (!parsed || !c) return null;
  if (parsed === "Europe") return EUROPE_CODES.has(c) ? null : false;
  const name = PARSED_COUNTRY_NAME[c];
  // every country the parser names is in PARSED_COUNTRY_NAME, so for a code it has no name
  // for, the parsed country is definitely somewhere else
  return name ? parsed === name : false;
}

type CountryFields = Pick<ParsedLocation, "country"> & { countries?: readonly string[] | undefined };

/**
 * ISO-2 codes of every country a parsed location names, primary first. Falls back to the
 * primary `country` for a location parsed before `countries` existed. [] when none is known
 * (or only the region "Europe").
 */
export function locationCountryCodes(loc: CountryFields): string[] {
  if (loc.countries?.length) return [...loc.countries];
  const c = codeForParsedCountry(loc.country);
  return c ? [c] : [];
}

/**
 * `parsedCountryMatches` over EVERY place a location names: `true` = one of its places is
 * in `code`; `false` = every place is definitely elsewhere; `null` = can't tell (nothing
 * parsed, or a European place vs a European country — the right region, as for "Europe").
 * A multi-office role is "abroad" only when none of its offices is home, so anything built
 * on `false` (the impossible-location rule, the visa discount) can only get narrower.
 */
export function locationInCountry(loc: CountryFields, code: string): boolean | null {
  const c = code.trim().toUpperCase();
  const legacy = parsedCountryMatches(loc.country, c);
  const codes = loc.countries ?? [];
  if (!c || !codes.length) return legacy;
  if (legacy === true || codes.includes(c)) return true;
  if (legacy === null || (EUROPE_CODES.has(c) && codes.some((x) => EUROPE_CODES.has(x)))) return null;
  return false;
}

/** does the location name a European place (the region "Europe" or a European country)? */
function inEurope(loc: CountryFields): boolean {
  return loc.country === "Europe" || (loc.countries ?? []).some((x) => EUROPE_CODES.has(x));
}

/**
 * Workable from one of `markets` (ISO-2): onsite/hybrid with an office in a market country
 * (or a European office for a European market — same region; the parser keeps "Europe" as
 * the primary country), or remote open to a market or to a geo in `remoteGeoOk`. A soft
 * prioritisation/view signal, never a gate.
 */
export function isWorkableIn(
  loc: ParsedLocation,
  markets: readonly string[],
  remoteGeoOk: readonly RemoteGeo[] = [],
): boolean {
  if (loc.mode === "onsite" || loc.mode === "hybrid") {
    return markets.some((m) => {
      const hit = locationInCountry(loc, m);
      return hit === true || (hit === null && inEurope(loc) && EUROPE_CODES.has(m.trim().toUpperCase()));
    });
  }
  if (loc.mode === "remote") {
    const open = new Set<RemoteGeo>(remoteGeoOk);
    for (const m of markets) for (const g of remoteGeosForCountry(m)) open.add(g);
    return open.has(loc.remoteGeo);
  }
  return false;
}

/**
 * Best-effort ISO-2 for a place NAME ("Bengaluru", "remote-india", "Berlin", "Toronto") —
 * used to infer a home country from location-preference labels. null when unsure.
 */
export function countryCodeFromText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  return placeCodes(t)[0] ?? null;
}
