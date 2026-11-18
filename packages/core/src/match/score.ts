import type { Posting, Profile, ScoreBreakdown } from "../schema/entities.js";
import { LevelBandOrder, type LevelBand, type RemoteGeo, type RoleArchetype } from "../schema/enums.js";
import { cosine, clamp } from "../util/vector.js";
import { convertCurrency, formatSalary } from "../salary/fx.js";
import { skillText, stackAdjacency, transfer, type StackAdjacencyResult } from "./stack.js";
import { countryDisplayName, locationInCountry, primaryRemoteGeo, remoteGeosForCountry } from "../normalize/location.js";
import { effectiveHomeCountry, effectiveMarkets, effectiveRemoteGeos } from "./region.js";
import { placeCountries } from "./display.js";
import { EVERGREEN_TITLE_RE, REDATED_SOURCES, TALENT_POOL_JD_RE, scoreSourceTrust } from "./trust.js";

/**
 * Soft-weighted match scoring (§11). Almost NOTHING is a hard filter — a hard
 * "Java-only" / "exactly-2-YoE" / "Pune-only" filter would hide most roles you'd
 * actually be strong for. Everything is a weighted signal with an honest flag.
 * Only two genuine hard exclusions: salary below your floor, and a truly
 * impossible location (onsite abroad with no relocation/sponsorship, or a remote role
 * explicitly restricted to a geo outside your `remoteGeoOk`).
 */

/**
 * Seniority, location and freshness carry real weight: they're the signals that decide
 * whether you can actually get the role (a perfect-stack staff role, a US-only remote,
 * or a 4-month-old req are all dead ends). Semantic is trimmed because the offline
 * embedder barely discriminates until a real model is configured.
 */
export const DEFAULT_WEIGHTS = {
  semantic: 0.16,
  stackAdjacency: 0.19,
  archetype: 0.15,
  seniority: 0.16,
  location: 0.18,
  freshness: 0.08,
  salary: 0.03,
  sourceTrust: 0.05,
} as const;

export type ScoreWeights = typeof DEFAULT_WEIGHTS;

export interface ScoredMatch {
  postingId: string;
  score: number; // 0-100
  breakdown: ScoreBreakdown;
  rulePass: boolean;
  flags: {
    stack: StackAdjacencyResult;
    levelNote: string | null;
    locationNote: string | null;
    redFlags: string[];
    hardExclusionReason: string | null;
  };
}

export function scorePosting(
  posting: Posting,
  profile: Profile,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoredMatch {
  const redFlags: string[] = [];

  // ── component: semantic similarity (pgvector cosine in prod) ──
  const semantic =
    posting.jdEmbedding && profile.profileEmbedding
      ? clamp((cosine(posting.jdEmbedding, profile.profileEmbedding) + 1) / 2) // map [-1,1]→[0,1]
      : 0.5; // neutral when not yet embedded

  // ── component: stack adjacency ──
  const stack = stackAdjacency(profile.prefs.stackProfile, posting.jdSkills, { title: posting.title, jdText: posting.jdText });

  // ── component: role archetype fit — keeps non-eng roles (sales, ops) out of top ──
  const { score: archetype, flag: archetypeFlag } = scoreArchetype(
    posting.roleArchetype,
    profile.prefs.targetArchetypes,
    posting.title,
  );
  if (archetypeFlag) redFlags.push(archetypeFlag);

  // ── component: seniority band + asked YoE (§11.2) ──
  const { score: seniority, note: levelNote, flag: levelFlag } = scoreSeniority(profile, posting);
  if (levelFlag) redFlags.push(levelFlag);

  // ── component: location & remote-geo (§11.3) ──
  const locResult = scoreLocation(posting, profile);
  for (const f of locResult.flags) redFlags.push(f);

  // ── component: freshness (§3) — real publish age + how recently we re-verified it ──
  const { score: freshness, flags: freshFlags } = scoreFreshness(posting);
  for (const f of freshFlags) redFlags.push(f);

  // ── component: salary fit (stated pay, else the estimate scaled by its confidence) ──
  const { score: salaryScore, flag: salaryFlag } = scoreSalary(posting, profile);
  if (salaryFlag) redFlags.push(salaryFlag);

  // ── component: source trust (§3) — real, open, and likely to get a reply ──
  // who is actually hiring (an agency, an unnamed employer, an AI-training gig) is never
  // crowded out by the flag cap: a reader must see it before they apply
  const trust = scoreSourceTrust(posting);
  for (const f of trust.flags) if (redFlags.length < 5 || TRUST_MUST_SHOW.test(f)) redFlags.push(f);

  // ── stretch flag for "X required" must-haves you don't have (never an exclusion) ──
  // only where nothing you know transfers to it (a Java dev isn't "missing" Kotlin)
  const missingMust = posting.requirements
    .filter((r) => r.strength === "must_have" && !profile.prefs.stackProfile.includes(r.skill))
    .filter((r) => !profile.prefs.stackProfile.some((o) => transfer(o, r.skill) >= 0.7))
    .map((r) => skillText(r.skill));
  if (missingMust.length && redFlags.length < 4) {
    const shown = missingMust.slice(0, 3);
    redFlags.push(`Asks for ${shown.join(", ")}${missingMust.length > 3 ? " …" : ""} — not in your skills`);
  }

  const breakdown: ScoreBreakdown = {
    semantic,
    stackAdjacency: stack.score,
    archetype,
    seniority,
    location: locResult.score,
    freshness,
    salary: salaryScore,
    sourceTrust: trust.score,
  };

  const raw =
    weights.semantic * semantic +
    weights.stackAdjacency * stack.score +
    weights.archetype * archetype +
    weights.seniority * seniority +
    weights.location * locResult.score +
    weights.freshness * freshness +
    weights.salary * salaryScore +
    weights.sourceTrust * trust.score;

  // Feasibility: the weighted sum is additive, so strong other signals could carry a role
  // you realistically can't land or don't want (7+ yrs asked, visa-bound onsite,
  // restricted remote, a non-engineering "Risk Analyst" at a great India office). Scale by
  // the weakest "is this even my role" signal — soft (≥0.6×): it re-orders, it never
  // hides (invariant #4).
  // An AI-training gig ("Software Engineer | $50/hr", rating model output) is a non-target
  // role wearing an engineering title — dampened like one, and flagged, never hidden.
  // An unpaid / volunteer "role" is damped the same way.
  const feasibility = Math.min(seniority, locResult.score, archetype, trust.aiTrainingGig ? 0.2 : 1, trust.unpaid ? 0.2 : 1);
  const damp = feasibility >= 0.5 ? 1 : 0.6 + 0.8 * feasibility;
  // A req open for months is usually filled, evergreen or a talent pool, yet freshness is
  // one small component, so a 300-day-old role sat among this week's (2026-11 feed review:
  // 9 of a top 50 were 140–300 days old). A soft re-order, never a filter.
  const score = Math.round(raw * damp * staleDamp(postingAgeDays(posting)) * 100);

  // ── HARD EXCLUSIONS — the only two (§11.3) ──
  const hardExclusionReason = hardExclude(posting, profile);
  const rulePass = hardExclusionReason === null;

  return {
    postingId: posting.id,
    score,
    breakdown,
    rulePass,
    flags: {
      stack,
      levelNote,
      locationNote: locResult.note,
      redFlags,
      hardExclusionReason,
    },
  };
}

/** ≤60 days: none; then 0.95 → 0.9 → 0.85 past 180 days (the flag says how old it is) */
export function staleDamp(ageDays: number): number {
  return ageDays <= 60 ? 1 : ageDays <= 120 ? 0.95 : ageDays <= 180 ? 0.9 : 0.85;
}

// ── role archetype fit (§11.1 — surface adjacency, down-weight off-target) ──
/** trust flags about WHO is hiring — always shown, whatever else is flagged */
const TRUST_MUST_SHOW = /staffing agency|freelance marketplace|Employer not named|AI-training gig|Unpaid/;

const ENG_ARCHETYPES = new Set<RoleArchetype>([
  "backend",
  "platform",
  "fullstack",
  "infra_devops",
  "data_ml",
  "sre",
  "frontend",
  "mobile",
]);

/**
 * How well a role of one engineering archetype suits someone targeting another, [0,1].
 * Directional and per target (2026-11 feed review): one flat 0.65 let a frontend
 * developer's top 50 fill with data-engineering, ML and SRE roles, and a backend-centric
 * "frontend/mobile are far" rule never applied the other way round.
 */
const ARCHETYPE_ADJACENCY: Readonly<Partial<Record<RoleArchetype, Partial<Record<RoleArchetype, number>>>>> = {
  backend: { platform: 0.75, fullstack: 0.7, infra_devops: 0.6, sre: 0.6, data_ml: 0.5, frontend: 0.4, mobile: 0.35 },
  platform: { infra_devops: 0.8, sre: 0.8, backend: 0.75, fullstack: 0.5, data_ml: 0.45, frontend: 0.3, mobile: 0.3 },
  infra_devops: { sre: 0.85, platform: 0.8, backend: 0.55, data_ml: 0.4, fullstack: 0.4, frontend: 0.25, mobile: 0.25 },
  sre: { infra_devops: 0.85, platform: 0.8, backend: 0.55, fullstack: 0.4, data_ml: 0.35, frontend: 0.25, mobile: 0.25 },
  fullstack: { frontend: 0.8, backend: 0.5, mobile: 0.35, platform: 0.45, data_ml: 0.35, infra_devops: 0.35, sre: 0.35 },
  frontend: { fullstack: 0.8, mobile: 0.4, backend: 0.35, platform: 0.25, data_ml: 0.2, infra_devops: 0.2, sre: 0.2 },
  mobile: { frontend: 0.6, fullstack: 0.55, backend: 0.35, platform: 0.25, data_ml: 0.2, infra_devops: 0.2, sre: 0.2 },
  data_ml: { backend: 0.45, platform: 0.4, infra_devops: 0.35, fullstack: 0.3, sre: 0.3, frontend: 0.15, mobile: 0.15 },
};

/**
 * Data / analytics titles the title normalizer files under "other" ("Data Analyst",
 * "Analytics Engineer", "Senior Data Scientist, People Analytics"): for someone targeting
 * data roles they ARE the target, not a non-engineering role at 0.08 (2026-11: 76 of 82
 * analyst-titled roles in a US corpus were "other", so a data analyst's feed held none).
 */
const DATA_TITLE_RE = /\b(data|analytics|bi|business intelligence|reporting|insights?|product|marketing|growth)\s+(analyst|scientist)s?\b|\b(data|analytics|bi)\s+(engineer|developer)s?\b|\bdata science\b|\bmachine learning (engineer|scientist)s?\b/i;
/** "Data Center Operations Engineer" is facilities work, not a data role */
const NOT_DATA_TITLE_RE = /\bdata\s*cent(er|re)s?\b/i;

function scoreArchetype(
  jd: RoleArchetype,
  targets: RoleArchetype[],
  title = "",
): { score: number; flag: string | null } {
  if (targets.includes(jd)) return { score: 1, flag: null };
  const effective: RoleArchetype =
    jd === "other" && targets.includes("data_ml") && DATA_TITLE_RE.test(title) && !NOT_DATA_TITLE_RE.test(title) ? "data_ml" : jd;
  if (targets.includes(effective)) return { score: 1, flag: null };
  // adjacent engineering archetypes still transfer (a backend dev can do platform/sre)
  if (ENG_ARCHETYPES.has(effective)) {
    const fits = targets.map((t) => ARCHETYPE_ADJACENCY[t]?.[effective] ?? (ENG_ARCHETYPES.has(t) ? 0.4 : 0.65));
    return { score: fits.length ? Math.max(...fits) : 0.65, flag: null };
  }
  // "other" = non-engineering (sales, ops, design, AE) — a JD picked up by boilerplate
  return { score: 0.08, flag: "Not an engineering role (sales, ops, support or similar)" };
}

// ── seniority ─────────────────────────────────────────────────────────────
/**
 * Two views of the same question, and the binding one wins: the title's band
 * ("Senior", "SDE-3") and the YoE the JD asks for. Most titles carry no level
 * ("Software Engineer", "SRE 3" before the ladder fix) while the JD says "7+ years" —
 * scoring only the title let those rank as a perfect fit for ~2 YoE (§11.2).
 */
function scoreSeniority(
  profile: Profile,
  posting: Posting,
): { score: number; note: string | null; flag: string | null } {
  const band = scoreBand(profile.levelBand, posting.levelBand);
  const yoe = scoreYoeGap(posting.experience, profile.yoe);
  if (!yoe) return band;
  if (!posting.levelBand) return yoe;
  return yoe.score < band.score ? { ...yoe, note: yoe.note ?? band.note } : band;
}

/**
 * Asked-YoE vs yours → score. Indian recruiters (and Naukri/LinkedIn filters) screen
 * on the stated range, so a 3-year gap is usually a resume-screen reject even when the
 * title reads mid-level ("SDE", "Software Engineer" + "5+ years"). One year short is
 * normal and scores full; being far ABOVE the range reads as overqualified.
 */
function scoreYoeGap(
  exp: Posting["experience"],
  yoe: number,
): { score: number; note: string | null; flag: string | null } | null {
  if (exp.min == null && exp.max == null) return null;
  const asked =
    exp.min == null ? `up to ${exp.max}` : exp.max != null && exp.max !== exp.min ? `${exp.min}–${exp.max}` : `${exp.min}+`;
  if (exp.max != null && yoe - exp.max >= 2) {
    return { score: 0.6, note: `Asks ${asked} yrs, you have ~${yoe} — may read as overqualified.`, flag: null };
  }
  if (exp.min == null) return null;
  const gap = exp.min - yoe;
  if (gap <= 1) return { score: 1, note: null, flag: null };
  if (gap <= 2) return { score: 0.6, note: `Asks ${asked} yrs, you have ~${yoe} — reachable stretch if the rest fits.`, flag: null };
  if (gap <= 3) return { score: 0.3, note: `Asks ${asked} yrs, you have ~${yoe} — likely screened out on YoE.`, flag: `Seniority stretch: asks ${asked} yrs (you have ~${yoe})` };
  if (gap <= 4) return { score: 0.2, note: `Asks ${asked} yrs, you have ~${yoe} — senior role.`, flag: `Seniority gap: asks ${asked} yrs (you have ~${yoe}) — big stretch` };
  return { score: 0.1, note: `Asks ${asked} yrs — not your role yet.`, flag: `Large seniority gap: asks ${asked} yrs (you have ~${yoe}) — big stretch` };
}

function scoreBand(
  yours: LevelBand,
  jd: LevelBand | null,
): { score: number; note: string | null; flag: string | null } {
  if (!jd) return { score: 0.7, note: null, flag: null };
  // internships are for students — not a level-down you can apply to with real YoE
  if (jd === "intern" && yours !== "intern") {
    return { score: 0.15, note: `Internship — meant for students, not ${levelText(yours)} engineers.`, flag: "Internship role" };
  }
  const delta = LevelBandOrder[jd] - LevelBandOrder[yours];
  const them = cap(levelText(jd));
  // delta 0 = perfect; +1 = mild stretch up (often aspirational, fine); +2 = real stretch
  if (delta <= 0) {
    return {
      score: delta < -1 ? 0.7 : 0.95, // level-down at a dream co is fine, slight down-weight
      note: delta < -1 ? `${them} role; you're ${levelText(yours)} — well below your level.` : delta < 0 ? `${them} role; you're ${levelText(yours)} — a step down.` : null,
      flag: null,
    };
  }
  if (delta === 1) {
    return { score: 0.7, note: `${them} role; you're ${levelText(yours)} — a common step up.`, flag: null };
  }
  if (delta === 2) {
    return {
      score: 0.3,
      note: `${them} role; you're ${levelText(yours)} — a big step up; your projects would have to make the case.`,
      flag: `Seniority gap: ${levelText(jd)} role`,
    };
  }
  return { score: 0.1, note: `${them} role — well above your level for now.`, flag: `Large seniority gap: ${levelText(jd)} role` };
}

/** "mid" → "mid-level"; the rest read as they are */
function levelText(band: LevelBand): string {
  return band === "mid" ? "mid-level" : band;
}

// ── location ──────────────────────────────────────────────────────────────
const GEO_PENALTY: Record<RemoteGeo, number> = {
  worldwide: 1,
  india_ok: 1,
  apac_ok: 0.95,
  us_eu: 0.4,
  eu_only: 0.35,
  us_only: 0.25,
  country_only: 0.3, // residents of another country (the caller opens it for home / markets)
  unknown: 0.7,
};

/**
 * Remote-geo penalty for a user whose home is OUTSIDE India: geos open from home score 1
 * (handled by the caller); a geo named for somewhere else is a likely dead end.
 */
const GEO_PENALTY_ELSEWHERE: Record<RemoteGeo, number> = {
  worldwide: 1,
  india_ok: 0.3,
  apac_ok: 0.5,
  us_eu: 0.4,
  eu_only: 0.35,
  us_only: 0.25,
  country_only: 0.3,
  unknown: 0.7,
};
/** home unknown: a restricted geo may or may not be open — mildly below an open one. */
const GEO_PENALTY_UNKNOWN_HOME: Record<RemoteGeo, number> = {
  worldwide: 1,
  india_ok: 0.6,
  apac_ok: 0.6,
  us_eu: 0.6,
  eu_only: 0.6,
  us_only: 0.6,
  country_only: 0.6,
  unknown: 0.7,
};

function geoPenalty(home: string, geo: RemoteGeo): number {
  if (!home) return GEO_PENALTY_UNKNOWN_HOME[geo];
  return home === "IN" ? GEO_PENALTY[geo] : GEO_PENALTY_ELSEWHERE[geo];
}

/** below this, the parsed geo is a guess — dampen the score + flag it honestly (§11.3). */
const LOW_LOCATION_CONFIDENCE = 0.5;
/** small honest boost so roles in your own country rank well (§11.3). */
const HOME_ONSITE_BOOST = 0.1;

function scoreLocation(
  posting: Posting,
  profile: Profile,
): { score: number; note: string | null; flags: string[] } {
  const loc = posting.location;
  const weights = profile.prefs.locationWeights;
  const flags: string[] = [];
  // where the user lives (ISO-2; "" = unknown → neutral, nothing is "abroad")
  const home = effectiveHomeCountry(profile.prefs);
  const homeGeos = home ? remoteGeosForCountry(home) : [];

  // base from the user's weighted ranked prefs (§11.3) — match label fragments
  const labelScore = matchLocationLabel(loc, weights);

  let score: number;
  let note: string | null;

  if (loc.mode === "remote") {
    // geo restriction MULTIPLIES the pref score so a restricted "remote" is down-weighted
    // hard, not surfaced as a clean remote match (§11.3). The user's own `remoteGeoOk`
    // plus the geos open from home decide which count as open; the penalty table covers
    // the rest.
    const geoOk = [...(profile.prefs.remoteGeoOk ?? []), ...homeGeos];
    let geo = geoOk.includes(loc.remoteGeo) ? 1 : geoPenalty(home, loc.remoteGeo);
    const primary = home ? primaryRemoteGeo(home) : null;
    const openBonus = loc.remoteGeo === "worldwide" || (primary !== null && loc.remoteGeo === primary) ? 0.1 : 0;
    // "Remote - Brazil" / "Remote Singapore": remote WITHIN named countries (`country_only`;
    // rows parsed before it existed read `unknown` + a country). Open from there or one of
    // your markets; from anywhere else it usually needs residency — as closed as a geo named
    // for somewhere else (soft, §11.3; the hard rule needs ≥0.85 confidence, see hardExclude).
    const countryOnly =
      loc.remoteGeo === "country_only" || (loc.remoteGeo === "unknown" && loc.country != null && loc.country !== "Europe" && home !== "");
    const where = countryOnly ? remoteCountriesLabel(loc) : "";
    if (countryOnly) {
      const places = [home, ...effectiveMarkets(profile.prefs)].filter(Boolean);
      if (places.some((c) => locationInCountry(loc, c) === true)) geo = 1;
      else if (home) {
        geo = GEO_PENALTY_ELSEWHERE.country_only;
        flags.push(`"Remote" within ${where} — usually requires living there`);
      }
    }
    score = clamp(labelScore * geo + openBonus);
    note = countryOnly ? `Remote (${where}).` : `Remote (${loc.remoteGeo}).`;
    // restricted geos not open from home get an honest flag (home unknown: say what it is)
    const closed = !homeGeos.includes(loc.remoteGeo);
    if (loc.remoteGeo === "us_only" && closed) {
      flags.push(home ? `"Remote" is US-only / US work-auth — not actually open to you` : `"Remote" is US-only / US work-auth`);
      note = home ? `"Remote" but US-only — false-positive remote.` : `"Remote" but US-only.`;
    } else if (loc.remoteGeo === "eu_only" && closed) {
      flags.push(`"Remote" is EU-only`);
    } else if (loc.remoteGeo === "us_eu" && closed) {
      flags.push(`"Remote" is limited to US/EU`);
    } else if (loc.remoteGeo === "india_ok" && closed && home) {
      flags.push(`"Remote" is India-only`);
    }
  } else if (loc.mode === "hybrid" || loc.mode === "onsite") {
    // onsite/hybrid in your own country is workable — a small honest boost, not a filter.
    // true = an office in your country, false = every office definitely elsewhere,
    // null = can't tell / home unknown
    const where = home ? locationInCountry(loc, home) : null;
    const atHome = where === true;
    score = clamp(atHome ? labelScore + HOME_ONSITE_BOOST : labelScore);
    // onsite abroad needs a work visa. Explicit sponsorship keeps it viable; silence is
    // usually "no" for early-career roles, so it's a real (soft) discount + an honest flag.
    if (loc.country && where === false) {
      if (loc.sponsorship === false) {
        score *= 0.3;
        flags.push(`Onsite in ${placeCountries(loc)}, no visa sponsorship offered`);
      } else if (loc.sponsorship == null) {
        score *= 0.6;
        flags.push(`Onsite in ${placeCountries(loc)} — visa sponsorship not mentioned`);
      }
    }
    note = `${cap(loc.mode)}${loc.city ? ` · ${loc.city}` : ""}${atHome ? ` · ${countryDisplayName(home)}-workable` : ""}.`;
  } else {
    score = 0.5;
    note = null;
  }

  // honest confidence handling (§11.3): when we're unsure of the geo, pull the score
  // toward neutral and surface a "verify" flag — don't rank a guess as if it were fact.
  if (loc.confidence < LOW_LOCATION_CONFIDENCE) {
    score = clamp(score * 0.85 + 0.5 * 0.15);
    flags.push("Location uncertain — verify before applying");
    note = `${note ?? ""} (location uncertain)`.trim();
  }

  return { score: clamp(score), note, flags };
}

function matchLocationLabel(
  loc: Posting["location"],
  weights: Profile["prefs"]["locationWeights"],
): number {
  if (weights.length === 0) return 0.7;
  const max = Math.max(...weights.map((w) => w.weight), 1);
  const hay = `${loc.mode} ${loc.city ?? ""} ${loc.country ?? ""} ${loc.remoteGeo}`.toLowerCase();
  let best = 0.3; // default for "anywhere else"
  for (const w of weights) {
    const frag = w.label.toLowerCase();
    if (
      hay.includes(frag) ||
      (frag.includes("remote") && loc.mode === "remote") ||
      (frag.includes("india") && loc.country === "India")
    ) {
      best = Math.max(best, w.weight / max);
    }
  }
  return best;
}

// ── freshness ─────────────────────────────────────────────────────────────
/** re-verified (seen in a poll) within this many days → trusted as still open. */
export const VERIFIED_WITHIN_DAYS = 10;
/** open longer than this → likely filled, evergreen, or a talent-pool req (§3). */
const EVERGREEN_AFTER_DAYS = 60;

/**
 * Two questions (§3): how old is the ROLE (source publish date, falling back to when
 * we first saw it), and how recently did we CONFIRM it's still up (lastSeen)? A
 * posting nobody has re-polled in weeks is unverified no matter how new it looked.
 * A role can't be newer than our first sighting of it: boards that re-stamp reposts
 * (Oracle, Keka, Jibe, Himalayas) report a later date than the one we saw it under, so
 * the earlier of the two wins.
 */
export function postingAgeDays(posting: Pick<Posting, "postedAt" | "firstSeen">, now = Date.now()): number {
  const seen = new Date(posting.firstSeen as string | Date).getTime();
  const posted = posting.postedAt ? new Date(posting.postedAt as string | Date).getTime() : Infinity;
  return Math.max(0, (now - Math.min(seen, posted)) / 86_400_000);
}

function scoreFreshness(posting: Posting): { score: number; flags: string[] } {
  const flags: string[] = [];
  const ageDays = postingAgeDays(posting);
  let score =
    ageDays <= 3 ? 1 : ageDays <= 7 ? 0.9 : ageDays <= 14 ? 0.75 : ageDays <= 30 ? 0.55 : ageDays <= 60 ? 0.3 : 0.15;
  // ATS-direct sources are ghost-free; nudge them above aggregators (§3)
  if (posting.atsType !== "unknown") score += 0.1;
  // a board that re-stamps dates can't prove recency — cap what its "posted today" earns
  if (REDATED_SOURCES.has(posting.source)) score = Math.min(score, 0.55);
  // no publish date at all (a dateless board's first poll): "first seen today" only means
  // we just started looking, so its age is unknown — not new
  if (!posting.postedAt) score = Math.min(score, 0.55);
  if (EVERGREEN_TITLE_RE.test(posting.title) || TALENT_POOL_JD_RE.test(posting.jdText.slice(0, 2000))) {
    score = Math.min(score, 0.15);
    flags.push("Talent-pool / evergreen req — not a specific open seat");
  } else if (ageDays > EVERGREEN_AFTER_DAYS) {
    flags.push(`Open ~${Math.round(ageDays)} days — may be filled or an evergreen req`);
  }

  const sinceSeen = (Date.now() - new Date(posting.lastSeen as string | Date).getTime()) / 86_400_000;
  if (sinceSeen > VERIFIED_WITHIN_DAYS) {
    score *= 0.5;
    flags.push(`Not re-verified in ${Math.round(sinceSeen)} days — may be closed`);
  }
  return { score: clamp(score), flags };
}

// ── salary ────────────────────────────────────────────────────────────────
const SALARY_NEUTRAL = 0.6;
/** how far a stated band of each confidence may move the score off neutral */
const STATED_TRUST: Record<Posting["salary"]["confidence"], number> = { high: 1, medium_high: 0.8, medium: 0.5, low: 0.3 };

/**
 * Pay vs your floor (§11.4), converted into your currency (nominal FX — a USD offer pays
 * USD wherever you sit). Stated pay moves the score by how sure the parse is; an ESTIMATE
 * moves it by its confidenceScore, so a weak guess stays near neutral. A soft signal with an
 * honest flag — the only hard gate is `hardExclude` on a stated, high-confidence ceiling.
 */
export function scoreSalary(posting: Posting, profile: Profile): { score: number; flag: string | null } {
  const floor = profile.prefs.salaryFloor;
  if (!floor) return { score: 0.7, flag: null };
  const want = profile.prefs.currency;
  const s = posting.salary;

  const stated = s.source !== "none" ? (s.max ?? s.min) : null;
  if (stated != null) {
    const top = convertCurrency(stated, s.currency, want);
    if (top == null) return { score: SALARY_NEUTRAL, flag: null };
    const score = SALARY_NEUTRAL + STATED_TRUST[s.confidence] * (floorFit(top, floor) - SALARY_NEUTRAL);
    // only a stated CEILING can be below the floor; a "from ₹X" says nothing about the top
    const flag =
      s.max != null && top < floor * 0.8
        ? `Posted pay tops out at ~${formatSalary(top, want)}, below your floor (${formatSalary(floor, want)})`
        : null;
    return { score, flag };
  }

  const e = posting.salaryEstimate;
  if (e) {
    const top = convertCurrency(e.max, e.currency, want);
    if (top == null) return { score: SALARY_NEUTRAL, flag: null };
    const score = SALARY_NEUTRAL + e.confidenceScore * (floorFit(top, floor) - SALARY_NEUTRAL);
    const flag =
      e.confidenceScore >= 0.45 && top < floor * 0.8
        ? `Estimated pay (~${formatSalary(top, want)} at the top, ${Math.round(e.confidenceScore * 100)}% confidence) likely below your floor`
        : null;
    return { score, flag };
  }
  return { score: SALARY_NEUTRAL, flag: null }; // unknown comp → neutral, never excluded on a guess
}

function floorFit(top: number, floor: number): number {
  return top >= floor ? 1 : top >= floor * 0.8 ? 0.6 : 0.3;
}

// ── the only two hard exclusions (§11.3) ────────────────────────────────────
function hardExclude(posting: Posting, profile: Profile): string | null {
  // 1. salary genuinely below floor — only a HIGH-confidence STATED ceiling, in your own
  //    currency (no FX guesswork at a hard gate). A floor-only band ("from ₹X") never
  //    qualifies, and an estimate lives in `salaryEstimate`, never here.
  const floor = profile.prefs.salaryFloor;
  const top = posting.salary.max;
  if (
    floor > 0 &&
    top != null &&
    posting.salary.source !== "none" &&
    posting.salary.confidence === "high" &&
    posting.salary.currency === profile.prefs.currency &&
    top < floor * 0.7
  ) {
    return `Comp ${top} ${posting.salary.currency} is well below your floor (${floor})`;
  }

  // 2. genuinely impossible location: onsite abroad, no sponsorship, you can't relocate.
  //    "Abroad" needs a KNOWN home: with no home country set or inferable, nothing is
  //    abroad and this never fires (region-neutral, nothing assumed).
  const home = effectiveHomeCountry(profile.prefs);
  if (
    (posting.location.mode === "onsite" || posting.location.mode === "hybrid") &&
    posting.location.country != null &&
    home !== "" &&
    locationInCountry(posting.location, home) === false && // abroad = NO office is home
    posting.location.sponsorship === false &&
    !profile.prefs.relocate
  ) {
    return `Onsite ${posting.location.country}, no sponsorship, relocation off`;
  }

  // 2b. the remote twin of the same rule: a remote role that EXPLICITLY requires living
  //     in / work authorization for a geo you've said you can't work from. Relocation
  //     can't fix a remote-US role, so this is as impossible as onsite-no-sponsorship.
  //     High confidence only — an inferred/ambiguous geo stays a soft down-weight (§11.3).
  const loc = posting.location;
  if (
    loc.mode === "remote" &&
    RESTRICTED_GEOS.has(loc.remoteGeo) &&
    loc.confidence >= RESTRICTION_CONFIDENCE &&
    // geos open from home count as yours (a US user can take a US-only remote role)
    !effectiveRemoteGeos(profile.prefs).includes(loc.remoteGeo)
  ) {
    return `Remote restricted to ${GEO_LABEL[loc.remoteGeo]} — outside your remote-geo prefs`;
  }

  // 2c. remote for residents of named countries (`country_only`), same bar: explicit (≥0.85)
  //     and none of the countries is your home or a market — every one definitely elsewhere.
  if (loc.mode === "remote" && loc.remoteGeo === "country_only" && loc.confidence >= RESTRICTION_CONFIDENCE) {
    const places = [home, ...effectiveMarkets(profile.prefs)].filter(Boolean);
    if (places.length && places.every((c) => locationInCountry(loc, c) === false)) {
      return `Remote restricted to residents of ${remoteCountriesLabel(loc)} — not your home or a market`;
    }
  }

  return null;
}

const RESTRICTED_GEOS = new Set<RemoteGeo>(["us_only", "eu_only", "us_eu"]);
/** the parser reports ≥0.85 for an explicit location field or explicit JD restriction. */
const RESTRICTION_CONFIDENCE = 0.85;
const GEO_LABEL: Partial<Record<RemoteGeo, string>> = { us_only: "US/Americas", eu_only: "EU/UK", us_eu: "US/EU" };

/** "Canada", "Canada / Brazil": the countries a country-scoped remote role names. */
function remoteCountriesLabel(loc: Posting["location"]): string {
  const names = (loc.countries ?? []).map(countryDisplayName);
  return names.length ? names.slice(0, 3).join(" / ") + (names.length > 3 ? " …" : "") : (loc.country ?? "one country");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
