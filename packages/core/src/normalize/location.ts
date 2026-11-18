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

const INDIA_CITIES = /\b(bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|secunderabad|delhi|new delhi|ncr|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|gandhinagar|gift city|vadodara|jaipur|indore|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|mysore|mysuru|mangalore|mangaluru|chandigarh|mohali|bhubaneswar|visakhapatnam|vizag|nagpur|lucknow|hubli|hubballi|surat|sonipat|madurai|nashik|bhopal|patna|ranchi|raipur|guwahati|dehradun|vijayawada|kanpur|ludhiana|rajkot|tiruchirappalli|trichy|belgaum|belagavi|manipal|udaipur|jodhpur|goa|panaji|india)\b/i;
/** an Indian city — the city slot never takes the country word ("Remote - India" has no city). */
const INDIA_CITY_ONLY = new RegExp(INDIA_CITIES.source.replace("|india)", ")"), "i");
/** US signal in a LOCATION string (short, structured) — case-insensitive is safe here. */
const US_HINT_RE = /\b(united states|usa|u\.s\.a?\.?|us|new york|nyc|san francisco|sf|bay area|seattle|austin|boston|chicago|los angeles|denver|atlanta|miami|palo alto|mountain view|menlo park|sunnyvale|san jose|san mateo|redwood city|oakland|portland|dallas|houston|philadelphia|pittsburgh|washington,? d\.?c\.?|remote[ -]?us|us[ -]?based|bellevue|redmond|kirkland|santa clara|cupertino|san diego|irvine|nashville|raleigh|durham|charlotte|phoenix|tempe|salt lake city|minneapolis|detroit|columbus|st\.? louis|kansas city|baltimore|arlington|reston|herndon|mclean|plano|irving|jersey city|hoboken|honolulu|pleasanton|schenectady|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b|,\s*(CA|NY|WA|TX|MA|IL|CO|GA|FL|OR|UT|NC|VA|NJ|PA|AZ|MN|MI|OH|DC)\b|\bUS-[A-Z]{2}\b|\bu\.s\.(?:a\.)?(?![a-z])/i;
/**
 * US state codes read after a comma ("Birmingham, AL"), case-sensitive. Left out: codes that
 * are also ISO codes of countries this parser names (AR Argentina, DE Germany, ID Indonesia,
 * IN India, MT Malta) — "Walldorf, DE" is Germany.
 */
const US_STATE_CODES =
  "CA|NY|WA|TX|MA|IL|CO|GA|FL|OR|UT|NC|VA|NJ|PA|AZ|MN|MI|OH|DC|AL|AK|CT|HI|IA|KS|KY|LA|ME|MD|MS|MO|NE|NV|NH|NM|ND|OK|RI|SC|SD|TN|VT|WV|WI|WY";
const US_HINT = {
  test(s: string): boolean {
    return US_HINT_RE.test(s) || US_STATE_SUFFIX.test(s);
  },
};
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
  ["GB", /\b(united kingdom|uk|great britain|britain|england|scotland|(?<!south )wales|northern ireland)\b/i, /\b(london|manchester|edinburgh|glasgow|bristol|oxford|leeds|liverpool|newcastle upon tyne|belfast|cardiff|sheffield|nottingham|brighton|milton keynes|guildford|aberdeen|southampton|leicester|coventry|exeter|plymouth|wolverhampton|watford|swansea|dundee|swindon|slough|basingstoke|cheltenham|bournemouth|crawley|stoke-on-trent|henley-on-thames)\b/i],
  ["IE", /\b((?<!northern )ireland|eire)\b/i, /\b(dublin|cork|galway|limerick|waterford)\b/i],
  ["DE", /\b(germany|deutschland)\b/i, /\b(berlin|munich|munchen|muenchen|hamburg|frankfurt|cologne|koln|koeln|stuttgart|dusseldorf|duesseldorf|leipzig|dresden|nuremberg|nurnberg|nuernberg|hannover|bonn|karlsruhe|mannheim|heidelberg|dortmund|bremen|potsdam|freiburg|aachen|darmstadt|wiesbaden|mainz|walldorf|ingolstadt|wolfsburg|erlangen|augsburg|braunschweig|chemnitz|zwickau|osnabruck|osnabrueck|wurzburg|wuerzburg|bielefeld|essen|gottingen|goettingen|rosenheim|landshut|erfurt|wuppertal|kiel|lubeck|luebeck|rostock|magdeburg|kassel|regensburg|ulm|bochum|duisburg|saarbrucken|saarbruecken|paderborn|jena|heilbronn|bremerhaven|luneburg|lueneburg|deggendorf|ansbach|neumunster|unterschleissheim)\b/i],
  ["NL", /\b(netherlands|nederland|holland)\b/i, /\b(amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag|delft|leiden|groningen|haarlem|amstelveen|hilversum|nijmegen|arnhem|breda|tilburg|enschede|vlissingen|boxmeer|zwolle|maastricht|leeuwarden|almere|hoofddorp)\b/i],
  ["FR", /\b(france)\b/i, /\b(paris|lyon|marseille|toulouse|nantes|bordeaux|lille|grenoble|montpellier|rennes|strasbourg|sophia antipolis|villeurbanne|massy|neuilly-sur-seine|issy[- ]les[- ]moulineaux|boulogne-billancourt|courbevoie|nanterre|puteaux|levallois-perret|la defense|caen|rouen|annecy|aix-en-provence|brest|saint-etienne|avignon|reims|dijon|angers|clermont-ferrand|metz|toulon|amiens|limoges|mulhouse|besancon|poitiers)\b/i],
  ["ES", /\b(spain|espana)\b/i, /\b(madrid|barcelona|valencia|seville|sevilla|malaga|bilbao|zaragoza|zamudio|alicante|murcia|palma de mallorca|san sebastian|donostia|vigo|a coruna|valladolid|granada)\b/i],
  ["PT", /\b(portugal)\b/i, /\b(lisbon|lisboa|porto(?! alegre)|braga|coimbra|aveiro)\b/i],
  ["PL", /\b(poland|polska)\b/i, /\b(warsaw|warszawa|krakow|cracow|wroclaw|gdansk|poznan|lodz|katowice|gdynia|szczecin|lublin|elblag|bydgoszcz|rzeszow|bialystok|torun)\b/i],
  ["IT", /\b(italy|italia)\b/i, /\b(milan|milano|rome|roma|turin|torino|naples|napoli|firenze|bologna|genoa|genova|venezia|padova|padua|trieste|treviso|verona|palermo|pescara|campobasso|catania|bari|brescia|bergamo|modena|parma|perugia|cagliari|ancona)\b/i],
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
  ["HU", /\b(hungary|magyarorszag)\b/i, /\b(budapest|debrecen|szeged|gyor|veresegyhaz)\b/i],
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
  ["AL", /\b(albania)\b/i, /\b(tirana)\b/i],
  ["MK", /\b(north macedonia|macedonia)\b/i, /\b(skopje)\b/i],
];
/** the display name `parseLocation` reports as the primary country for a European place. */
const EUROPE_COUNTRY_NAME: Readonly<Record<string, string>> = {
  GB: "United Kingdom", IE: "Ireland", DE: "Germany", NL: "Netherlands", FR: "France", ES: "Spain",
  PT: "Portugal", PL: "Poland", IT: "Italy", SE: "Sweden", DK: "Denmark", FI: "Finland", NO: "Norway",
  AT: "Austria", BE: "Belgium", CH: "Switzerland", CZ: "Czechia", RO: "Romania", GR: "Greece",
  HU: "Hungary", LU: "Luxembourg", EE: "Estonia", LV: "Latvia", LT: "Lithuania", SK: "Slovakia",
  SI: "Slovenia", HR: "Croatia", BG: "Bulgaria", IS: "Iceland", UA: "Ukraine", RS: "Serbia",
  CY: "Cyprus", MT: "Malta", AL: "Albania", MK: "North Macedonia",
};
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
  ["KR", "South Korea", /\b(south korea|korea|seoul|busan|pangyo|changwon|incheon|daejeon|suwon)\b/i],
  ["AU", "Australia", /\b(australia|sydney|melbourne|brisbane|perth|canberra|adelaide)\b/i],
  ["NZ", "New Zealand", /\b(new zealand|auckland|wellington)\b/i],
  ["CN", "China", /\b(china|beijing|shanghai|shenzhen|guangzhou|hangzhou|chengdu)\b/i],
  ["HK", "Hong Kong", /\bhong kong\b/i],
  ["TW", "Taiwan", /\b(taiwan|taipei|hsinchu|tainan|taichung|kaohsiung)\b/i],
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
  ["MX", "Mexico", /\b((?<!new )mexico|guadalajara|monterrey|cienega de flores|queretaro|tijuana)\b/i],
  ["BR", "Brazil", /\b(brazil|brasil|s[aã]o paulo|rio de janeiro|curitiba|florian[oó]polis|belo horizonte|campinas|porto alegre|recife|s[aã]o jos[eé] dos campos)\b/i],
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
  ["TN", "Tunisia", /\b(tunisia|tunis)\b/i],
  ["MA", "Morocco", /\b(morocco|casablanca|rabat)\b/i],
  ["MU", "Mauritius", /\b(mauritius|ebene|port louis)\b/i],
  ["KZ", "Kazakhstan", /\b(kazakhstan|almaty|astana)\b/i],
  ["EC", "Ecuador", /\b(ecuador|quito|guayaquil)\b/i],
  ["GH", "Ghana", /\b(ghana|accra)\b/i],
  ["UG", "Uganda", /\b(uganda|kampala)\b/i],
  ["RW", "Rwanda", /\b(rwanda|kigali)\b/i],
  ["ET", "Ethiopia", /\b(ethiopia|addis ababa)\b/i],
  ["NP", "Nepal", /\b(nepal|kathmandu)\b/i],
  ["AM", "Armenia", /\b(armenia|yerevan)\b/i],
  ["UZ", "Uzbekistan", /\b(uzbekistan|tashkent)\b/i],
  ["JO", "Jordan", /\b(jordan|amman)\b/i],
  ["LB", "Lebanon", /\b(lebanon|beirut)\b/i],
  ["BH", "Bahrain", /\b(bahrain|manama)\b/i],
  ["OM", "Oman", /\b(oman|muscat)\b/i],
  ["BM", "Bermuda", /\bbermuda\b/i],
  ["PA", "Panama", /\bpanama\b(?! city)/i],
  ["GT", "Guatemala", /\bguatemala\b/i],
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
const US_STATE_SUFFIX = new RegExp(`,\\s*(${US_STATE_CODES})\\b|\\bUS-[A-Z]{2}\\b`);

// ── comma-separated place lists in ONE segment ("London, Berlin") ──

/** US state names (lower-case, folded). New York / Washington are cities first: not here. */
const US_STATE_NAMES = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "west virginia", "wisconsin", "wyoming", "district of columbia",
]);
/** every US state code, collisions included: as a QUALIFIER the place before it disambiguates. */
const US_STATE_CODE_SET = new Set([...US_STATE_CODES.split("|"), "AR", "DE", "ID", "IN", "MT"]);
/** Indian state codes HR systems write after a city ("Pune, MH, India"). */
const IN_STATE_CODES = new Set(["KA", "MH", "HR", "TN", "TS", "TG", "AP", "UP", "DL", "WB", "GJ", "RJ", "KL", "MP", "OD", "PB", "CH"]);
const CA_PROVINCE_CODES = new Set(["ON", "BC", "QC", "AB", "MB", "NS", "NB", "NL", "PE", "SK", "YT", "NT", "NU"]);
const CA_PROVINCE_NAMES = new Set([
  "ontario", "quebec", "british columbia", "alberta", "manitoba", "nova scotia", "new brunswick",
  "newfoundland and labrador", "newfoundland", "prince edward island", "saskatchewan", "yukon",
]);
/** first-level regions elsewhere that follow a city ("Hyderabad, Telangana", "Sydney, NSW"). */
const OTHER_REGIONS: Readonly<Record<string, string>> = {
  karnataka: "IN", maharashtra: "IN", telangana: "IN", "tamil nadu": "IN", haryana: "IN", "uttar pradesh": "IN",
  kerala: "IN", gujarat: "IN", "west bengal": "IN", "andhra pradesh": "IN", rajasthan: "IN", odisha: "IN", punjab: "IN",
  "new south wales": "AU", nsw: "AU", victoria: "AU", vic: "AU", queensland: "AU", qld: "AU", "western australia": "AU",
  bavaria: "DE", bayern: "DE", hesse: "DE", hessen: "DE", "baden-wurttemberg": "DE", "baden wurttemberg": "DE",
  "north rhine-westphalia": "DE", "nordrhein-westfalen": "DE",
  "ile-de-france": "FR", "ile de france": "FR", catalonia: "ES", catalunya: "ES", "community of madrid": "ES",
  "north holland": "NL", "noord-holland": "NL", "south holland": "NL", "zuid-holland": "NL",
  "greater london": "GB", "county dublin": "IE", "co. dublin": "IE",
};
/** country names (folded, lower-case) beyond the European `names` patterns. */
const COUNTRY_NAME_ALIASES: Readonly<Record<string, string>> = {
  "united states": "US", "united states of america": "US", usa: "US", us: "US", "u.s.": "US", "u.s": "US", "u.s.a.": "US", "u.s.a": "US",
  canada: "CA", india: "IN", uae: "AE", ksa: "SA", brasil: "BR", turkiye: "TR", "viet nam": "VN", korea: "KR",
  "republic of korea": "KR", "the netherlands": "NL",
};

/** the bare place words of one comma part: folded, lower-case, mode words and brackets dropped. */
function partText(part: string): string {
  return foldPlace(part)
    .toLowerCase()
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/\b(remote|hybrid|on[ -]?site|in[ -]?office|office|hq|headquarters)\b/g, " ")
    .replace(/[^a-z.\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.'-]+|[\s'-]+$/g, "")
    .trim();
}

/** ISO-2 when the whole part is a country NAME ("Germany", "United Kingdom", "Japan"). */
function countryNameCode(part: string): string | null {
  const t = partText(part);
  if (!t) return null;
  const alias = COUNTRY_NAME_ALIASES[t];
  if (alias) return alias;
  for (const [code, names] of EUROPE_PLACES) {
    const m = t.match(names);
    if (m && m[0].length === t.length) return code;
  }
  for (const [code, name] of OTHER_COUNTRIES) if (name.toLowerCase() === t) return code;
  return null;
}

type CommaPart =
  | { kind: "country"; code: string }
  | { kind: "region"; codes: readonly string[]; code2?: boolean }
  | { kind: "city"; code: string }
  | { kind: "unknown" };

function classifyPart(part: string): CommaPart {
  const raw = part.trim();
  const named = countryNameCode(raw);
  if (named) return { kind: "country", code: named };
  // a bare two-letter code is a qualifier: a US state, a Canadian province, or a country code
  if (/^[A-Z]{2}$/.test(raw)) {
    const codes: string[] = [];
    if (US_STATE_CODE_SET.has(raw)) codes.push("US");
    if (CA_PROVINCE_CODES.has(raw)) codes.push("CA");
    if (IN_STATE_CODES.has(raw)) codes.push("IN"); // "Bengaluru, KA", "Chennai, TN" (not Tennessee)
    if (PARSED_COUNTRY_NAME[raw]) codes.push(raw); // "Berlin, DE"
    return { kind: "region", codes, code2: true };
  }
  const t = partText(raw);
  if (!t) return { kind: "unknown" };
  if (US_STATE_NAMES.has(t)) return { kind: "region", codes: ["US"] };
  if (CA_PROVINCE_NAMES.has(t)) return { kind: "region", codes: ["CA"] };
  const other = OTHER_REGIONS[t];
  if (other) return { kind: "region", codes: [other] };
  // a part that NAMES a country inside other words ("Anywhere in France") is that country,
  // so the next country name starts a new place instead of re-qualifying this one
  const f = foldPlace(raw);
  const inName = US_NAME.test(f) ? "US" : CANADA_NAME.test(f) ? "CA" : EUROPE_PLACES.find(([, names]) => names.test(f))?.[0];
  if (inName) return { kind: "country", code: inName };
  const code = placeCodes(raw)[0];
  return code ? { kind: "city", code } : { kind: "unknown" };
}

/**
 * A comma-only list of places in one segment: "London, Berlin", "Toronto, ON, Canada, New
 * York, NY", "Bangalore, Hyderabad, Pune". Commas there do two jobs — qualifying a place
 * ("Dublin, OH", "Albuquerque, New Mexico", "Austin, TX, United States") and listing places —
 * so each part is classified: a known city or an unknown word starts a place; a state /
 * province / region code or a country name that follows qualifies the place before it (and
 * overrules the city's own country: "Dublin, OH" is Ohio, "London, Ontario" is Canada).
 * Returns the places' countries only when they name 2+ DISTINCT countries — otherwise null,
 * and the segment resolves as one place, as before (conservative: a qualifier pair never
 * splits).
 */
function commaListCodes(segment: string): string[] | null {
  const parts = segment.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const codes = commaPlaces(parts);
  if (codes.length >= 2) return codes;
  // ONE place, qualified: "Perth, Scotland", "Sydney, Nova Scotia, Canada" — the qualifier
  // decides, where the whole-segment reading would also add the city's namesake country
  const whole = placeCodes(segment);
  const only = codes[0];
  if (only && (whole.includes(only) || !whole.length)) return [only];
  return null;
}

function commaPlaces(parts: readonly string[]): string[] {
  const places: Array<{ code: string | null; qualified: boolean; named: boolean }> = [];
  for (const part of parts) {
    const c = classifyPart(part);
    const cur = places[places.length - 1];
    if (c.kind === "region") {
      if (cur && !cur.qualified && !cur.named) {
        // a two-letter code that is the city's own country ("Berlin, DE") keeps it; else the
        // first reading (a US state before a Canadian province before an ISO code) wins
        cur.code = cur.code && c.codes.includes(cur.code) ? cur.code : (c.codes[0] ?? null);
        cur.qualified = true;
      } else {
        // a region on its own ("…, Texas") names its country; a lone two-letter code is
        // ambiguous ("CA": California or Canada) and names nothing
        places.push({ code: c.code2 ? null : (c.codes[0] ?? null), qualified: true, named: false });
      }
    } else if (c.kind === "country") {
      if (cur && !cur.named && (!cur.qualified || cur.code === c.code)) {
        cur.code = c.code;
        cur.named = true;
      } else {
        places.push({ code: c.code, qualified: true, named: true });
      }
    } else {
      places.push({ code: c.kind === "city" ? c.code : null, qualified: false, named: false });
    }
  }
  const codes: string[] = [];
  for (const p of places) if (p.code && !codes.includes(p.code)) codes.push(p.code);
  return codes;
}

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
  const loc = expandPlaceCodes(locationRaw ?? "").replace(/\bUS-[A-Z]{2}-[^;,|]*/g, "US");
  const out: string[] = [];
  const first = codeForParsedCountry(primary);
  if (first) out.push(first);
  for (const seg of loc.split(PLACE_SEPARATOR)) {
    for (const c of commaListCodes(seg) ?? placeCodes(seg)) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** ISO-3 country codes some HR systems (Workday, Oracle) lead a location with. */
const ISO3: Readonly<Record<string, string>> = {
  IND: "IN", USA: "US", CAN: "CA", GBR: "GB", IRL: "IE", DEU: "DE", NLD: "NL", FRA: "FR", ESP: "ES", PRT: "PT",
  POL: "PL", ITA: "IT", SWE: "SE", DNK: "DK", FIN: "FI", NOR: "NO", AUT: "AT", BEL: "BE", CHE: "CH", CZE: "CZ",
  ROU: "RO", GRC: "GR", HUN: "HU", LUX: "LU", EST: "EE", LVA: "LV", LTU: "LT", SVK: "SK", SVN: "SI", HRV: "HR",
  BGR: "BG", UKR: "UA", SRB: "RS", SGP: "SG", JPN: "JP", KOR: "KR", AUS: "AU", NZL: "NZ", CHN: "CN", HKG: "HK",
  TWN: "TW", PHL: "PH", MYS: "MY", THA: "TH", IDN: "ID", VNM: "VN", ARE: "AE", SAU: "SA", ISR: "IL", TUR: "TR",
  ZAF: "ZA", NGA: "NG", KEN: "KE", EGY: "EG", MEX: "MX", BRA: "BR", ARG: "AR", COL: "CO", CHL: "CL", PER: "PE",
  CRI: "CR", URY: "UY", PAK: "PK", BGD: "BD", LKA: "LK", TUN: "TN", MAR: "MA",
};
/** Indian site codes (airport-style) in "IND-BLR-Divyasree Technopolis". */
const IN_SITE_CODES: Readonly<Record<string, string>> = {
  BLR: "Bengaluru", HYD: "Hyderabad", MAA: "Chennai", CHN: "Chennai", BOM: "Mumbai", MUM: "Mumbai", PNQ: "Pune",
  PUN: "Pune", DEL: "Delhi", NOI: "Noida", GGN: "Gurugram", GUR: "Gurugram", CCU: "Kolkata", AMD: "Ahmedabad",
};
/** US state codes that read as the US on their own ("Remote - MA", "TX - Frisco"): not CA (Canada?), ME (Middle East?) or ISO clashes. */
const US_STATE_ALONE = US_STATE_CODES.split("|").filter((c) => c !== "CA" && c !== "ME").join("|");
const STATE_DASH = new RegExp(`(^|[;|]\\s*|\\bremote\\s*-\\s*(?:remote-)?)(${US_STATE_ALONE})(?=\\s*(?:$|[;|]|-\\s|\\s+metro\\b))`, "gi");

/**
 * Codes some sources lead a place with, spelled out so every reading below resolves them:
 * Workday's ISO-3 prefixes ("IND BNGL FL2-3", "DEU - Bayern - Unterschleissheim" → "India,
 * BNGL FL2-3", "Germany, Bayern - …") and a bare US state code after "Remote -" or before
 * " - City" ("Remote - MA", "TX - Frisco" → "US-MA", the Ashby form the hints already read).
 */
function expandPlaceCodes(raw: string): string {
  return raw
    .replace(/\bIND-([A-Z]{3})-/g, (m, c: string) => (IN_SITE_CODES[c] ? `${IN_SITE_CODES[c]}, ` : m))
    .replace(/(^|[;|•\n]\s*)([A-Z]{3})(?:\s+-\s+|\s+)(?=\S)/g, (m, pre: string, c3: string) => {
      const code = ISO3[c3];
      return code ? `${pre}${countryDisplayName(code)}, ` : m;
    })
    .replace(STATE_DASH, (m, pre: string, st: string) => (st === st.toUpperCase() ? `${pre}US-${st}` : m));
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
/** in a LOCATION string, "Home based - Worldwide" / "Work from home" are remote too. */
const REMOTE_LOC_RE = /\b(remote|home[- ]based|work from home|wfh)\b/i;
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
  const raw = expandPlaceCodes((locationRaw ?? "").trim());
  // hints read "US-CA-Dublin" as the US, not as Dublin, Ireland (Ashby's ISO-prefixed form)
  const loc = raw.replace(/\bUS-[A-Z]{2}-[^;,|]*/g, "US");
  const jd = jdText ?? "";

  // 1. mode — location string first; JD prose only fills a gap
  let mode: LocationMode = "unknown";
  if (HYBRID_RE.test(loc)) mode = "hybrid";
  else if (REMOTE_LOC_RE.test(loc)) mode = "remote";
  else if (ONSITE_RE.test(loc)) mode = "onsite";
  if (mode === "unknown") {
    if (HYBRID_RE.test(jd)) mode = "hybrid";
    else if (loc) mode = ROLE_REMOTE_RE.test(jd) ? "remote" : "onsite"; // a bare city implies onsite
    else if (STRONG_REMOTE_RE.test(jd)) mode = "remote";
    else if (REMOTE_RE.test(jd)) mode = "remote";
    else if (ONSITE_RE.test(jd)) mode = "onsite";
  }

  // 2. country/city (from the location string only). The rest of the world is left to the
  //    per-place reading below, which keeps the string's order ("Lagos, Cairo" is Nigeria first)
  let country: string | null = INDIA_CITIES.test(loc)
    ? "India"
    : US_HINT.test(loc)
      ? "United States"
      : CANADA_HINT.test(loc)
        ? "Canada"
        : EU_HINT.test(loc)
          ? "Europe"
          : null;
  const locForCity = cleanForCity(raw.replace(/\bUS-[A-Z]{2}\b(?!-)/g, " ")).replace(/\b(remote|home[- ]based|hybrid|on[ -]?site|in[ -]?office|anywhere|worldwide|global)\b/gi, " ");
  // up to three capitalised words ending at a separator: "San Francisco, CA", "New York
  // City", "Tel Aviv" — not just their first word. Unicode letters, so "München" and
  // "Kraków" are whole words, not "M" / "Krak".
  const cityMatch =
    locForCity.match(INDIA_CITY_ONLY) ??
    locForCity.match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}.'-]+(?:\s+\p{Lu}[\p{L}.'-]+){0,2}(?=\s*(?:[,(|/;]|\s-\s|$))/u) ??
    locForCity.match(/(?<![\p{L}\p{N}])(\p{Lu}\p{L}+)(?:,|\s|$)/u);
  const cityText = cityMatch ? cityMatch[0].replace(/,$/, "").trim() : null;
  // a country or region word is not a city: "Remote - Canada" has no city
  const city = cityText && !notACity(cityText) ? cityText : null;
  // every country the string names, place by place: a multi-office role is workable in each
  const placed = locationCountries(raw);
  // The primary country is a real country whenever one is known: "München" is Germany, not
  // the region "Europe" (kept only when no European country is named: "Remote - Europe").
  // When the per-place reading disagrees with the whole-string hint, the place wins:
  // "Durham, United Kingdom" is the UK, though Durham is also a US city hint. A place only
  // the per-place reading resolves ("Ingolstadt, Bavaria") still gets a country.
  let primary = country === "Europe" ? placed.find((c) => EUROPE_CODES.has(c)) : codeForParsedCountry(country);
  if (country !== "Europe" && (!primary || (placed.length && !placed.includes(primary)))) primary = placed[0] ?? primary;
  if (primary) country = countryDisplayName(primary);
  const countries = primary ? [primary, ...placed.filter((c) => c !== primary)] : placed;

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
      // "Remote - Brazil": remote WITHIN the named country (or countries: "Remote - Canada;
      // Brazil" — `countries`). A structured claim — JD boilerplate ("customers worldwide", a
      // stray "US") must not reinterpret it.
      remoteGeo = "country_only";
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
    // the country is stated, but "Remote - Canada" can mean "Canada-based team" as well as
    // "residents only": below the 0.85 the hard rule needs, so it stays a soft down-weight
    if (geoSource === "loc_country") return 0.8;
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
  ...EUROPE_COUNTRY_NAME,
  ...Object.fromEntries(OTHER_COUNTRIES.map(([code, name]) => [code, name])),
};

/**
 * Countries the parser only resolves to the region "Europe" (it names no European
 * country). A European home/market vs a "Europe" posting is the right REGION with an
 * unknown country — never "definitely abroad".
 */
export const EUROPE_CODES: ReadonlySet<string> = new Set([
  "GB", "IE", "DE", "NL", "FR", "ES", "PT", "PL", "IT", "SE", "DK", "FI", "NO", "AT", "BE", "CH",
  "CZ", "RO", "GR", "HU", "LU", "EE", "LV", "LT", "SK", "SI", "HR", "BG", "IS", "UA", "RS", "CY", "MT", "AL", "MK",
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
  return PARSED_COUNTRY_NAME[c] ?? c;
}

/**
 * Does a parsed posting country match an ISO-2 country? `true` = definitely there,
 * `false` = definitely elsewhere, `null` = can't tell (no country parsed, or only the
 * region "Europe" for a European country).
 */
export function parsedCountryMatches(parsed: string | null | undefined, code: string): boolean | null {
  const c = code.trim().toUpperCase();
  if (!parsed || !c) return null;
  if (parsed === "Europe") return EUROPE_CODES.has(c) ? null : false;
  if (PARSED_COUNTRY_NAME[c] === parsed) return true;
  // a European country vs another European country: the right region, never "definitely
  // abroad" — what the region "Europe" (the parser's answer before it named the country)
  // always meant, so nothing built on `false` widens
  const at = codeForParsedCountry(parsed);
  if (at && EUROPE_CODES.has(at) && EUROPE_CODES.has(c)) return null;
  // every country the parser names is in PARSED_COUNTRY_NAME, so the parsed country is
  // definitely somewhere else
  return false;
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
export function inEurope(loc: CountryFields): boolean {
  return locationCountryCodes(loc).some((x) => EUROPE_CODES.has(x)) || loc.country === "Europe";
}

const REGION_WORD = /^(europe|european union|eu|emea|apac|asia|asia pacific|americas|north america|latin america|latam|worldwide|anywhere|global|international|multiple|various|n\/a|tbd)$/;

/** a country or region word that the city slot must not take ("Remote - Canada", "UK"). */
function notACity(word: string): boolean {
  const code = countryNameCode(word);
  // a bare state / country code ("Remote - CA") is not a city either
  return (code != null && !CITY_STATES.has(code)) || REGION_WORD.test(partText(word)) || /^[A-Z]{2}$/.test(word.trim());
}
/** countries that are also their own city ("Singapore" is a city, "Canada" is not). */
const CITY_STATES: ReadonlySet<string> = new Set(["SG", "HK", "LU", "MT"]);

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
    // remote for residents of named countries: open when one of them is a market
    if (loc.remoteGeo === "country_only") return markets.some((m) => locationInCountry(loc, m) === true);
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
