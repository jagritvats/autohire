import { z } from "zod";
import {
  ApplicationStatus,
  AtsType,
  ExecutionTier,
  JobRuntime,
  JobStatus,
  JobType,
  LevelBand,
  LocationMode,
  PostingStatus,
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
  // comp benchmark (levels.fyi, attributed) — §11.4
  compMedian: z.number().nullable().default(null),
  compCurrency: z.string().nullable().default(null),
  compSource: z.string().nullable().default(null),
  compBreakdown: z.array(z.object({ family: z.string(), median: z.number() })).nullable().default(null),
  compUpdatedAt: ts.nullable().default(null),
  enrichedAt: ts.nullable().default(null),
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
  /** manual lifecycle (§3). Only `active` reaches the feed; `invalidated`/`stale`
   *  are excluded. `isActive` stays the "seen in the latest poll" freshness flag. */
  status: PostingStatus.default("active"),
  /** why it was manually invalidated (spam/dupe/fake), null unless invalidated. */
  invalidReason: z.string().nullable().default(null),
  invalidatedAt: ts.nullable().default(null),

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
/** Contact / identity used by the local form-filler (§7.1). Never invented — only
 *  what you put here is typed into a form, and it always stops at the review gate. */
export const Contact = z.object({
  firstName: z.string().default(""),
  lastName: z.string().default(""),
  email: z.string().default(""),
  phone: z.string().default(""),
  linkedin: z.string().default(""),
  github: z.string().default(""),
  portfolio: z.string().default(""),
  resumePath: z.string().default(""),
});
export type Contact = z.infer<typeof Contact>;

export const ProfilePrefs = z.object({
  salaryFloor: z.number().default(0),
  currency: z.string().default("INR"),
  contact: Contact.default({}),
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
  /** base resume text — pasted or extracted from an uploaded file; grounds generation (§4). */
  masterResume: z.string().default(""),
  /** raw base LaTeX résumé (when imported as .tex) — the template tailoring rewrites. */
  resumeLatex: z.string().default(""),
  /** free "about you" narrative — additional background grounding for generation (§4). */
  aboutText: z.string().default(""),
  profileEmbedding: z.array(z.number()).nullable().default(null),
  yoe: z.number().default(0),
  levelBand: LevelBand.default("mid"),
  prefs: ProfilePrefs,
});
export type Profile = z.infer<typeof Profile>;

// ── Generation — a cached, evidence-grounded draft (resume variants / answers, §4) ──
/** `resume` content is JSON.stringify(ResumeVariants); the rest are plain answer text. */
export const GenerationKind = z.enum([
  "resume",
  "resume_latex",
  "resume_md",
  "why_here",
  "interesting_problem",
  "about_blurb",
  "answer",
]);
export type GenerationKind = z.infer<typeof GenerationKind>;

export const Generation = z.object({
  id: uuid,
  tenantId: uuid,
  /** null = generic (settings drafts); set = tailored to a specific posting. */
  postingId: uuid.nullable().default(null),
  kind: GenerationKind,
  /** the question text, for free-form answers (part of the cache slot key). */
  prompt: z.string().default(""),
  content: z.string(),
  model: z.string().default("echo"),
  /** sha256 of the inputs — a mismatch means the draft is stale (§ cache). */
  inputHash: z.string(),
  createdAt: ts,
});
export type Generation = z.infer<typeof Generation>;

// ── Connected context — imported, read-only profile sources (§ Customize) ──
/** Where an imported context came from. `manual` = pasted by hand. */
export const ProfileSourceKind = z.enum(["github", "linkedin", "yc", "manual"]);
export type ProfileSourceKind = z.infer<typeof ProfileSourceKind>;

/**
 * A read-only context imported from an external source (GitHub repos, a LinkedIn
 * data-export, a YC/WaaS profile). It is *background* for generation — never merged
 * into the Evidence Bank or stack — so the Evidence Bank stays the citeable spine
 * (invariant #3). One row per (tenant, source); re-importing replaces it.
 */
export const ConnectedContext = z.object({
  id: uuid,
  tenantId: uuid,
  source: ProfileSourceKind,
  /** username / "export" / profile URL — identifies what was imported. */
  handle: z.string().default(""),
  /** display label (e.g. "github.com/jagritvats"). */
  label: z.string().default(""),
  /** rendered text fed to generation when `enabled`. */
  content: z.string().default(""),
  /** structured items (repos / positions) kept for display + re-render. */
  items: z.array(z.record(z.unknown())).default([]),
  /** only enabled contexts are fed to generation. */
  enabled: z.boolean().default(true),
  syncedAt: ts,
});
export type ConnectedContext = z.infer<typeof ConnectedContext>;

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

// ── Command-plane job (§ control plane: web enqueues, worker/agent drain) ──
export const Job = z.object({
  id: uuid,
  tenantId: uuid,
  type: JobType,
  runtime: JobRuntime,
  payload: z.record(z.unknown()).default({}),
  status: JobStatus.default("queued"),
  result: z.record(z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: ts,
  pickedAt: ts.nullable().default(null),
  finishedAt: ts.nullable().default(null),
});
export type Job = z.infer<typeof Job>;

// ── Local-agent heartbeat (§7.1) — proves the agent is online + its live flags ──
export const AgentHeartbeat = z.object({
  tenantId: uuid,
  lastSeen: ts,
  version: z.string().nullable().default(null),
  flags: z.record(z.unknown()).default({}),
  enabledSources: z.array(z.string()).default([]),
});
export type AgentHeartbeat = z.infer<typeof AgentHeartbeat>;

// ── Tenant config — drives behavior as DATA, edited in the settings UI (§6.1) ──
export const AutomationFlagsSchema = z.object({
  browser: z.enum(["off", "on"]).default("off"),
  mode: z.enum(["capture", "fill"]).default("capture"),
  autosubmit: z.literal(false).default(false), // hard-false by type
  rate: z.enum(["human", "fast"]).default("human"),
  tier3Sources: z.array(z.string()).default([]),
});
export type AutomationFlagsSchema = z.infer<typeof AutomationFlagsSchema>;

/** Supported generation providers — echo runs offline; the rest read a key (§ Customize). */
export const LlmChoice = z.enum(["echo", "anthropic", "grok", "openai"]);
export type LlmChoice = z.infer<typeof LlmChoice>;

export const TenantConfig = z.object({
  tenantId: uuid,
  sourcesEnabled: z
    .array(z.string())
    .default(["greenhouse", "lever", "ashby", "workable", "remotive", "arbeitnow", "hn_whoishiring"]),
  automationFlags: AutomationFlagsSchema.default({}),
  /** which generation provider runs (echo | anthropic | grok | openai). */
  llmChoice: z.string().default("echo"),
  /** strong-model override (blank → the provider's default model). */
  llmModel: z.string().default(""),
  /** API key for the chosen provider (blank → fall back to the matching env var). */
  llmApiKey: z.string().default(""),
  /** custom base URL / gateway (blank → the provider's default). */
  llmBaseUrl: z.string().default(""),
  digestCadence: z.enum(["off", "daily", "weekly"]).default("daily"),
});
export type TenantConfig = z.infer<typeof TenantConfig>;

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
