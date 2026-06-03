import { z } from "zod";
import {
  ApplicationStatus,
  AtsType,
  ExecutionTier,
  LevelBand,
  LocationMode,
  RemoteGeo,
  RequirementStrength,
  RoleArchetype,
  SalaryConfidence,
  SourceKind,
} from "./enums.js";

const uuid = z.string().uuid();
const ts = z.union([z.string().datetime({ offset: true }), z.date()]);

/** A parsed JD requirement with strength — `must_have` → stretch flag, never a hard exclude (§11.1). */
export const Requirement = z.object({
  skill: z.string(),
  strength: RequirementStrength,
});
export type Requirement = z.infer<typeof Requirement>;

/** Structured location parsed from a posting (§11.3). */
export const ParsedLocation = z.object({
  mode: LocationMode,
  city: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  timezone: z.string().nullable().default(null),
  remoteGeo: RemoteGeo.default("unknown"),
  sponsorship: z.boolean().nullable().default(null),
});
export type ParsedLocation = z.infer<typeof ParsedLocation>;

export const SalaryBand = z.object({
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  currency: z.string().default("USD"),
  source: z.string().default("none"),
  confidence: SalaryConfidence.default("low"),
});
export type SalaryBand = z.infer<typeof SalaryBand>;

// ── Company (shared global; the registry is the same for every tenant, §5) ──
export const Company = z.object({
  id: uuid,
  name: z.string(),
  nameNorm: z.string(),
  atsType: AtsType.default("unknown"),
  atsSlug: z.string().nullable().default(null),
  careersUrl: z.string().url().nullable().default(null),
  fundingStage: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  pollCadence: z.enum(["daily", "weekly", "manual"]).default("weekly"),
  lastPolled: ts.nullable().default(null),
  status: z.enum(["active", "paused", "dead"]).default("active"),
  // enrichment (filled by Enricher, §11.5)
  ratingOverall: z.number().nullable().default(null),
  ratingWlb: z.number().nullable().default(null),
  ratingComp: z.number().nullable().default(null),
  reviewCount: z.number().int().nullable().default(null),
  ratingSource: z.string().nullable().default(null),
  cultureSummary: z.string().nullable().default(null),
  interviewDifficulty: z.string().nullable().default(null),
  createdAt: ts.optional(),
});
export type Company = z.infer<typeof Company>;

// ── RawPosting — what an adapter emits before normalization (§ component: adapters) ──
export const RawPosting = z.object({
  source: SourceKind,
  tier: ExecutionTier,
  atsType: AtsType.default("unknown"),
  atsJobId: z.string(),
  companyName: z.string(),
  companySlug: z.string().nullable().default(null),
  title: z.string(),
  jdText: z.string().default(""),
  jdHtml: z.string().nullable().default(null),
  locationRaw: z.string().nullable().default(null),
  applyUrl: z.string().nullable().default(null),
  salaryRaw: z.string().nullable().default(null),
  postedAt: ts.nullable().default(null),
  fetchedAt: ts.default(() => new Date()),
  /** raw source-specific payload, kept for re-parsing without re-fetch */
  raw: z.record(z.unknown()).default({}),
});
export type RawPosting = z.infer<typeof RawPosting>;

// ── Posting — canonical normalized job (§5) ──
export const Posting = z.object({
  id: uuid,
  companyId: uuid,
  companyName: z.string(),
  atsType: AtsType.default("unknown"),
  atsJobId: z.string(),
  source: SourceKind,
  tier: ExecutionTier,

  title: z.string(),
  titleNorm: z.string(),
  roleArchetype: RoleArchetype.default("other"),
  levelBand: LevelBand.nullable().default(null),

  jdText: z.string().default(""),
  jdSkills: z.array(z.string()).default([]),
  requirements: z.array(Requirement).default([]),

  location: ParsedLocation,
  salary: SalaryBand,

  applyUrl: z.string().nullable().default(null),
  // embeddings live in pgvector; in JS we carry the array (or null until embedded)
  jdEmbedding: z.array(z.number()).nullable().default(null),

  // lifecycle / freshness (§3)
  firstSeen: ts,
  lastSeen: ts,
  isActive: z.boolean().default(true),
  repostCount: z.number().int().default(0),

  // dedup (§ Deduper) — self-ref to canonical winner
  canonicalId: uuid.nullable().default(null),
  dedupKey: z.string(),
});
export type Posting = z.infer<typeof Posting>;

// ── Evidence Bank — the anti-hallucination spine (§4, §5) ──
export const Evidence = z.object({
  id: uuid,
  tenantId: uuid,
  project: z.string(),
  headline: z.string(),
  detail: z.string(),
  metric: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  embedding: z.array(z.number()).nullable().default(null),
});
export type Evidence = z.infer<typeof Evidence>;

// ── Profile + prefs (§5, §11) ──
export const ProfilePrefs = z.object({
  salaryFloor: z.number().default(0),
  currency: z.string().default("INR"),
  /** weighted ranked location prefs, not binary (§11.3) */
  locationWeights: z
    .array(z.object({ label: z.string(), weight: z.number() }))
    .default([]),
  stackMustHaves: z.array(z.string()).default([]),
  stackProfile: z.array(z.string()).default([]),
  remoteGeoOk: z.array(RemoteGeo).default(["india_ok", "worldwide"]),
  relocate: z.boolean().default(true),
  targetArchetypes: z.array(RoleArchetype).default(["backend", "platform"]),
});
export type ProfilePrefs = z.infer<typeof ProfilePrefs>;

export const Profile = z.object({
  id: uuid,
  tenantId: uuid,
  masterResume: z.string().default(""),
  profileEmbedding: z.array(z.number()).nullable().default(null),
  yoe: z.number().default(0),
  levelBand: LevelBand.default("mid"),
  prefs: ProfilePrefs,
});
export type Profile = z.infer<typeof Profile>;

// ── Match — scored posting against a profile (§5, §11.6) ──
export const ScoreBreakdown = z.object({
  semantic: z.number(),
  stackAdjacency: z.number(),
  archetype: z.number(),
  seniority: z.number(),
  location: z.number(),
  freshness: z.number(),
  salary: z.number(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const Match = z.object({
  id: uuid,
  tenantId: uuid,
  postingId: uuid,
  score: z.number(),
  scoreBreakdown: ScoreBreakdown,
  rulePass: z.boolean(),
  // LLM re-rank narrative (§11.6) — null until re-ranked
  whyFit: z.string().nullable().default(null),
  gap: z.string().nullable().default(null),
  stackNote: z.string().nullable().default(null),
  levelNote: z.string().nullable().default(null),
  redFlags: z.array(z.string()).default([]),
  generatedAt: ts,
});
export type Match = z.infer<typeof Match>;

// ── Application CRM (§7) ──
export const Application = z.object({
  id: uuid,
  tenantId: uuid,
  postingId: uuid,
  status: ApplicationStatus.default("saved"),
  appliedVia: z.string().nullable().default(null),
  tailoredResumeUrl: z.string().nullable().default(null),
  resumeVariant: z.string().nullable().default(null),
  answers: z.record(z.string()).default({}),
  submittedAt: ts.nullable().default(null),
  nextAction: z.string().nullable().default(null),
  nextActionAt: ts.nullable().default(null),
  outcome: z.string().nullable().default(null),
});
export type Application = z.infer<typeof Application>;
