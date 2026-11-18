import { describe, expect, it } from "vitest";
import { dedup } from "../src/dedup/index.js";
import { normalizePosting } from "../src/normalize/index.js";
import { NORMALIZE_VERSION, isWorkableIn, locationInCountry, parseLocation, parsedCountryMatches } from "../src/normalize/index.js";
import { scorePosting } from "../src/match/index.js";
import { compSampleOf, estimateTargetOf, salaryMarketOf } from "../src/salary/index.js";
import { RawPosting, type Posting, type Profile } from "../src/schema/index.js";

/**
 * Fourth-pass location fixtures (docs/internal/DISCOVERY_AUDIT.md, "fourth pass"): comma-only
 * place lists, the primary country of a European place, country words that aren't cities, the
 * code forms HR systems use, and the two consumers that read only the primary country (dedup,
 * salary market). Fictional companies; location strings shaped like the live corpus's.
 */

const countriesOf = (raw: string) => parseLocation(raw).countries ?? [];

describe("comma-only lists of places in one segment", () => {
  it.each([
    ["London, Berlin", ["GB", "DE"]],
    ["Hybrid - London, Berlin", ["GB", "DE"]],
    ["San Francisco, London", ["US", "GB"]],
    ["Lagos, Cairo, Lahore", ["NG", "EG", "PK"]],
    ["Cambridge, MA, London", ["US", "GB"]],
    ["Anywhere in France, Belgium, Spain", ["FR", "BE", "ES"]],
  ])("%s → %j", (raw, codes) => {
    expect(countriesOf(raw)).toEqual(codes);
  });

  it("a list that crosses a qualified place keeps both countries", () => {
    expect(new Set(countriesOf("Toronto, ON, Canada, New York, NY"))).toEqual(new Set(["CA", "US"]));
  });

  it("a list inside one country is one country", () => {
    expect(countriesOf("Bangalore, Hyderabad, Pune")).toEqual(["IN"]);
    expect(countriesOf("Remote, Bengaluru (Bangalore), Delhi, Gurugram, Noida, Hyderabad")).toEqual(["IN"]);
  });

  it.each([
    // a qualifier never splits: "City, Region" stays one place, the region deciding
    ["Dublin, OH", ["US"]],
    ["Albuquerque, New Mexico", ["US"]],
    ["London, Ontario", ["CA"]],
    ["Paris, TX", ["US"]],
    ["Austin, TX, United States", ["US"]],
    ["Perth, Scotland", ["GB"]],
    ["Sydney, Nova Scotia, Canada", ["CA"]],
    ["Sydney, New South Wales, Australia", ["AU"]],
    ["Durham, United Kingdom", ["GB"]],
    ["Berlin, DE", ["DE"]],
    ["Amsterdam, NL", ["NL"]],
    // Indian state codes after a city are India (TN is Tamil Nadu here, not Tennessee)
    ["Bengaluru, KA, India", ["IN"]],
    ["Chennai, TN, India", ["IN"]],
    ["Hybrid - Gurugram, HR, India", ["IN"]],
    ["Memphis, TN", ["US"]],
    ["Hyderabad, Telangana, India", ["IN"]],
  ])("%s stays one place → %j", (raw, codes) => {
    expect(countriesOf(raw)).toEqual(codes);
  });
});

describe("the primary country is a country, not the region 'Europe'", () => {
  it("names the European country", () => {
    expect(parseLocation("München, Deutschland (Hybrid)")).toMatchObject({ country: "Germany", countries: ["DE"], city: "München" });
    expect(parseLocation("London, Berlin")).toMatchObject({ country: "United Kingdom", countries: ["GB", "DE"] });
    expect(parseLocation("Remote - UK").country).toBe("United Kingdom");
  });

  it("keeps 'Europe' only when no European country is named", () => {
    expect(parseLocation("Remote - Europe").country).toBe("Europe");
    expect(parseLocation("EMEA").country).toBe("Europe");
  });

  it("region rules read the same as for 'Europe': a European office is the right region", () => {
    const de = parseLocation("Berlin, Germany");
    expect(parsedCountryMatches("Germany", "DE")).toBe(true);
    expect(parsedCountryMatches("Germany", "FR")).toBeNull();
    expect(parsedCountryMatches("Germany", "IN")).toBe(false);
    expect(locationInCountry(de, "FR")).toBeNull();
    expect(isWorkableIn(de, ["FR"])).toBe(true);
    expect(isWorkableIn(de, ["US"])).toBe(false);
  });

  it("a 'europe' location preference (the eu-uk preset's) still matches a named European country", () => {
    const p = posting({ locationRaw: "Amsterdam, Netherlands" });
    const withLabel = (label: string) =>
      scorePosting(p, profileWith({ homeCountry: "NL", currency: "EUR", locationWeights: [{ label, weight: 1 }] })).breakdown.location;
    expect(withLabel("europe")).toBeGreaterThan(withLabel("asia"));
  });

  it("the per-place reading wins over a stray whole-string hint", () => {
    expect(parseLocation("Lagos, Cairo").country).toBe("Nigeria"); // listed order, not table order
    expect(parseLocation("Durham, United Kingdom").country).toBe("United Kingdom");
  });
});

describe("country and region words are not cities", () => {
  it.each(["Remote - Canada", "Remote - India", "Remote - US", "Remote - UK", "Remote North America", "Home based - Worldwide", "Remote - CA"])(
    "%s has no city",
    (raw) => {
      expect(parseLocation(raw).city).toBeNull();
    },
  );

  it("keeps the city when one follows the country", () => {
    expect(parseLocation("India - Hyderabad, India").city).toBe("Hyderabad");
    expect(parseLocation("India, Bengaluru").city).toBe("Bengaluru");
    expect(parseLocation("TX - Frisco").city).toBe("Frisco");
    expect(parseLocation("Singapore").city).toBe("Singapore"); // a city-state is its own city
  });
});

describe("code forms HR systems lead a place with", () => {
  it.each([
    ["IND BNGL FL2-3 TWR 3", "India"],
    ["DEU - Bayern - Unterschleissheim", "Germany"],
    ["NLD - North Brabant - Boxmeer", "Netherlands"],
    ["PER - Lima - Lima (Example WeWork)", "Peru"],
    ["IND-BLR-Example Tech Park, India", "India"],
    ["Remote - Remote-MA", "United States"],
    ["Remote - AZ; Remote - CA", "United States"],
    ["UT - Cottonwood Heights", "United States"],
    ["Birmingham, AL", "United States"],
    ["Remote Remote U.S.", "United States"],
  ])("%s → %s", (raw, country) => {
    expect(parseLocation(raw).country).toBe(country);
  });

  it("a lone 'Remote - CA' stays unplaced (California or Canada?)", () => {
    expect(parseLocation("Remote - CA").country).toBeNull();
  });

  it("'Home based' is remote", () => {
    expect(parseLocation("Home based - Worldwide")).toMatchObject({ mode: "remote", remoteGeo: "worldwide" });
    expect(parseLocation("Home Based - APAC")).toMatchObject({ mode: "remote", remoteGeo: "apac_ok" });
  });

  it("names places the parser didn't know", () => {
    expect(parseLocation("Tunis").country).toBe("Tunisia");
    expect(parseLocation("Remote - Morocco")).toMatchObject({ country: "Morocco", remoteGeo: "country_only" });
    expect(parseLocation("Villeurbanne").country).toBe("France");
    expect(parseLocation("Remote - Hubli")).toMatchObject({ country: "India", remoteGeo: "india_ok" });
    expect(parseLocation("Tirana, Albania").country).toBe("Albania");
  });
});

function profileWith(over: Partial<Profile["prefs"]>): Profile {
  return {
    id: "p1", tenantId: "t1", masterResume: "", resumeLatex: "", aboutText: "", profileEmbedding: null, yoe: 5,
    levelBand: "senior", onboardedAt: null, resumeFile: null,
    prefs: {
      salaryFloor: 0, currency: "EUR", homeCountry: "NL", markets: [],
      contact: { firstName: "", lastName: "", email: "", phone: "", linkedin: "", github: "", portfolio: "", resumePath: "" },
      locationWeights: [], stackMustHaves: [], stackProfile: ["kubernetes"], remoteGeoOk: ["eu_only", "worldwide"],
      relocate: false, targetArchetypes: ["platform"], ...over,
    },
  } as Profile;
}

function raw(over: Partial<RawPosting>): RawPosting {
  return RawPosting.parse({
    source: "greenhouse", tier: "tier1", atsType: "greenhouse", atsJobId: "1", companyName: "Examplecorp",
    title: "Senior Platform Engineer", jdText: "Run Kubernetes clusters.", locationRaw: "London, United Kingdom",
    ...over,
  });
}
let seq = 0;
function posting(r: Partial<RawPosting>, over: Partial<Posting> = {}): Posting {
  const n = normalizePosting(raw({ atsJobId: String(++seq), ...r }));
  const now = new Date();
  return {
    ...n, id: `p${seq}`, companyId: "c", salaryEstimate: null, jdEmbedding: null, embedKey: null, firstSeen: now, lastSeen: now,
    isActive: true, repostCount: 0, status: "active", invalidReason: null, invalidatedAt: null, canonicalId: null, ...over,
  } as Posting;
}

describe("dedup reads every country a posting names", () => {
  it("a board's multi-office role and an aggregator's one-office copy are one role", () => {
    const board = posting({ locationRaw: "Hybrid - Austin, TX; London, United Kingdom" });
    const agg = posting({ source: "himalayas", tier: "tier2", atsType: "unknown", locationRaw: "London, United Kingdom" });
    expect(board.location.countries).toEqual(["US", "GB"]);
    expect(dedup([agg, board]).canonicalIds).toEqual([board.id]);
  });

  it("different countries are different roles", () => {
    const inRole = posting({ locationRaw: "Bengaluru, India" });
    const usRole = posting({ source: "himalayas", tier: "tier2", atsType: "unknown", locationRaw: "Austin, TX" });
    expect(dedup([inRole, usRole]).canonicalIds).toHaveLength(2);
  });

  it("an older row's region 'Europe' still pairs with its named-country copy", () => {
    const old = posting({ locationRaw: "Berlin" }, {});
    old.location = { ...old.location, country: "Europe", countries: undefined, city: null };
    const fresh = posting({ source: "himalayas", tier: "tier2", atsType: "unknown", locationRaw: "Berlin, Germany" });
    fresh.location = { ...fresh.location, city: null };
    expect(dedup([old, fresh]).canonicalIds).toHaveLength(1);
  });
});

describe("salary market of a multi-country posting", () => {
  const usd = { min: 150_000, max: 190_000, currency: "USD", period: "year" as const, source: "jd_text" as const, confidence: "high" as const };
  const gbp = { ...usd, min: 90_000, max: 120_000, currency: "GBP" };

  it("is the primary country's", () => {
    const p = posting({ locationRaw: "New York, NY; London, United Kingdom" });
    expect(salaryMarketOf(p.location)).toBe("US");
    expect(estimateTargetOf(p)?.market).toBe("US");
  });

  it("follows a STATED currency to the named country it is paid in", () => {
    const p = posting({ locationRaw: "New York, NY; London, United Kingdom" }, { salary: gbp } as Partial<Posting>);
    expect(salaryMarketOf(p.location, "GBP")).toBe("GB");
    expect(compSampleOf(p)?.market).toBe("GB"); // a London comparable, not a dropped US one
    const q = posting({ locationRaw: "New York, NY; London, United Kingdom" }, { salary: usd } as Partial<Posting>);
    expect(compSampleOf(q)?.market).toBe("US");
  });

  it("never moves a single-country posting, or a remote role open beyond its countries", () => {
    expect(salaryMarketOf(parseLocation("Berlin, Germany"), "USD")).toBe("EU");
    expect(salaryMarketOf(parseLocation("Remote - Worldwide"), "EUR")).toBe("REMOTE");
  });

  it("prices a named European country like the region did", () => {
    expect(salaryMarketOf(parseLocation("Glasgow, Scotland"))).toBe("GB");
    expect(salaryMarketOf(parseLocation("Remote - UK"))).toBe("GB");
    expect(salaryMarketOf(parseLocation("München"))).toBe("EU");
    expect(salaryMarketOf(parseLocation("Singapore"))).toBe("SG");
  });
});

describe("NORMALIZE_VERSION", () => {
  it("is a positive integer (bump it whenever normalize logic changes)", () => {
    expect(Number.isInteger(NORMALIZE_VERSION) && NORMALIZE_VERSION > 0).toBe(true);
  });
});
