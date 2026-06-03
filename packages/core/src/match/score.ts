import type { Posting, Profile, ScoreBreakdown } from "../schema/entities.js";
import { LevelBandOrder, type LevelBand, type RemoteGeo, type RoleArchetype } from "../schema/enums.js";
import { cosine, clamp } from "../util/vector.js";
import { stackAdjacency, type StackAdjacencyResult } from "./stack.js";

/**
 * Soft-weighted match scoring (§11). Almost NOTHING is a hard filter — a hard
 * "Java-only" / "exactly-2-YoE" / "Pune-only" filter would hide most roles you'd
 * actually be strong for. Everything is a weighted signal with an honest flag.
 * Only two genuine hard exclusions: salary below your floor, and a truly
 * impossible location (onsite in a country with no relocation/sponsorship).
 */

export const DEFAULT_WEIGHTS = {
  semantic: 0.24,
  stackAdjacency: 0.24,
  archetype: 0.18,
  seniority: 0.1,
  location: 0.15,
  freshness: 0.04,
  salary: 0.05,
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
  const stack = stackAdjacency(profile.prefs.stackProfile, posting.jdSkills);

  // ── component: role archetype fit — keeps non-eng roles (sales, ops) out of top ──
  const { score: archetype, flag: archetypeFlag } = scoreArchetype(
    posting.roleArchetype,
    profile.prefs.targetArchetypes,
  );
  if (archetypeFlag) redFlags.push(archetypeFlag);

  // ── component: seniority band (§11.2) ──
  const { score: seniority, note: levelNote, flag: levelFlag } = scoreSeniority(
    profile.levelBand,
    posting.levelBand,
  );
  if (levelFlag) redFlags.push(levelFlag);

  // ── component: location & remote-geo (§11.3) ──
  const locResult = scoreLocation(posting, profile);
  if (locResult.flag) redFlags.push(locResult.flag);

  // ── component: freshness (§3) — ATS-direct + fresh ranks above stale aggregator ──
  const freshness = scoreFreshness(posting);

  // ── component: salary fit ──
  const salaryScore = scoreSalary(posting, profile);

  // ── stretch flag for "X required" must-haves you don't have (never an exclusion) ──
  for (const req of posting.requirements) {
    if (req.strength === "must_have" && !profile.prefs.stackProfile.includes(req.skill)) {
      // only surface a couple, and only if stack transfer is weak for it
      if (redFlags.length < 4) redFlags.push(`JD requires ${req.skill} (you don't list it — stretch)`);
    }
  }

  const breakdown: ScoreBreakdown = {
    semantic,
    stackAdjacency: stack.score,
    archetype,
    seniority,
    location: locResult.score,
    freshness,
    salary: salaryScore,
  };

  const raw =
    weights.semantic * semantic +
    weights.stackAdjacency * stack.score +
    weights.archetype * archetype +
    weights.seniority * seniority +
    weights.location * locResult.score +
    weights.freshness * freshness +
    weights.salary * salaryScore;

  const score = Math.round(raw * 100);

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

// ── role archetype fit (§11.1 — surface adjacency, down-weight off-target) ──
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

function scoreArchetype(
  jd: RoleArchetype,
  targets: RoleArchetype[],
): { score: number; flag: string | null } {
  if (targets.includes(jd)) return { score: 1, flag: null };
  // adjacent engineering archetypes still transfer (a backend dev can do platform/sre)
  if (ENG_ARCHETYPES.has(jd)) {
    // frontend/mobile are the far edge for a backend target (java→frontend 0.2, §11.1)
    const far = jd === "frontend" || jd === "mobile";
    return { score: far ? 0.4 : 0.65, flag: null };
  }
  // "other" = non-engineering (sales, ops, design, AE) — a JD picked up by boilerplate
  return { score: 0.08, flag: "Non-engineering role (off-target archetype)" };
}

// ── seniority ─────────────────────────────────────────────────────────────
function scoreSeniority(
  yours: LevelBand,
  jd: LevelBand | null,
): { score: number; note: string | null; flag: string | null } {
  if (!jd) return { score: 0.7, note: null, flag: null };
  const delta = LevelBandOrder[jd] - LevelBandOrder[yours];
  // delta 0 = perfect; +1 = mild stretch up (often aspirational, fine); +2 = real stretch
  if (delta <= 0) {
    return {
      score: delta < -1 ? 0.7 : 0.95, // level-down at a dream co is fine, slight down-weight
      note: delta < 0 ? `Posting is ${jd}; you're ${yours} — comfortable.` : null,
      flag: null,
    };
  }
  if (delta === 1) {
    return {
      score: 0.8,
      note: `Asks ${jd}, you're ${yours} — common stretch-up; "5+ yrs" is usually aspirational.`,
      flag: null,
    };
  }
  if (delta === 2) {
    return {
      score: 0.45,
      note: `Asks ${jd}, you're ${yours} — real stretch; project depth has to argue up.`,
      flag: `Seniority gap: role targets ${jd}`,
    };
  }
  return {
    score: 0.15,
    note: `Posting is ${jd} — likely not your role yet.`,
    flag: `Large seniority gap (${jd})`,
  };
}

// ── location ──────────────────────────────────────────────────────────────
const GEO_PENALTY: Record<RemoteGeo, number> = {
  worldwide: 1,
  india_ok: 1,
  apac_ok: 0.95,
  us_eu: 0.4,
  eu_only: 0.35,
  us_only: 0.25,
  unknown: 0.7,
};

function scoreLocation(
  posting: Posting,
  profile: Profile,
): { score: number; note: string | null; flag: string | null } {
  const loc = posting.location;
  const weights = profile.prefs.locationWeights;

  // base from the user's weighted ranked prefs (§11.3) — match label fragments
  const labelScore = matchLocationLabel(loc, weights);

  if (loc.mode === "remote") {
    // geo restriction MULTIPLIES the pref score so a us_only "remote" is down-weighted
    // hard, not surfaced as a clean remote match (§11.3).
    const geo = GEO_PENALTY[loc.remoteGeo];
    const openBonus = loc.remoteGeo === "india_ok" || loc.remoteGeo === "worldwide" ? 0.1 : 0;
    const score = clamp(labelScore * geo + openBonus);
    let flag: string | null = null;
    let note = `Remote (${loc.remoteGeo}).`;
    if (loc.remoteGeo === "us_only") {
      flag = `"Remote" is US-only / US work-auth — not actually open to you`;
      note = `"Remote" but US-only — false-positive remote.`;
    } else if (loc.remoteGeo === "eu_only") {
      flag = `"Remote" is EU-only`;
    }
    return { score: clamp(score), note, flag };
  }

  if (loc.mode === "hybrid" || loc.mode === "onsite") {
    let flag: string | null = null;
    // onsite abroad with no sponsorship and you can't relocate freely → flag
    if (loc.country && loc.country !== "India" && loc.sponsorship === false) {
      flag = `Onsite ${loc.country}, no sponsorship offered`;
    }
    const note = `${cap(loc.mode)}${loc.city ? ` · ${loc.city}` : ""}.`;
    return { score: clamp(labelScore), note, flag };
  }

  return { score: 0.5, note: null, flag: null };
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
function scoreFreshness(posting: Posting): number {
  const first = new Date(posting.firstSeen as string | Date).getTime();
  const ageDays = (Date.now() - first) / 86_400_000;
  const ageScore = ageDays <= 3 ? 1 : ageDays <= 7 ? 0.85 : ageDays <= 21 ? 0.6 : 0.35;
  // ATS-direct sources are ghost-free; nudge them above aggregators (§3)
  const atsBonus = posting.atsType !== "unknown" ? 0.1 : 0;
  return clamp(ageScore + atsBonus);
}

// ── salary ────────────────────────────────────────────────────────────────
function scoreSalary(posting: Posting, profile: Profile): number {
  const floor = profile.prefs.salaryFloor;
  if (!floor) return 0.7;
  const top = posting.salary.max ?? posting.salary.min;
  if (top == null) return 0.6; // unknown comp → neutral, never excluded on a guess
  // normalize crudely by currency floor; this is a soft signal, not the hard gate
  return top >= floor ? 1 : top >= floor * 0.8 ? 0.6 : 0.3;
}

// ── the only two hard exclusions (§11.3) ────────────────────────────────────
function hardExclude(posting: Posting, profile: Profile): string | null {
  // 1. salary genuinely below floor — only when we have a HIGH-confidence direct number
  const floor = profile.prefs.salaryFloor;
  const top = posting.salary.max ?? posting.salary.min;
  if (
    floor > 0 &&
    top != null &&
    posting.salary.confidence === "high" &&
    posting.salary.currency === profile.prefs.currency &&
    top < floor * 0.7
  ) {
    return `Comp ${top} ${posting.salary.currency} is well below your floor (${floor})`;
  }

  // 2. genuinely impossible location: onsite abroad, no sponsorship, you can't relocate
  if (
    (posting.location.mode === "onsite" || posting.location.mode === "hybrid") &&
    posting.location.country != null &&
    posting.location.country !== "India" &&
    posting.location.sponsorship === false &&
    !profile.prefs.relocate
  ) {
    return `Onsite ${posting.location.country}, no sponsorship, relocation off`;
  }

  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
