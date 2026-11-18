import { z } from "zod";
import {
  ApplicationStatus,
  AtsType,
  EvidenceOrigin,
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

/** A user-uploaded file kept OUTSIDE the repo tree (data dir or DB blob), keyed per tenant. */
export const StoredFile = z.object({
  key: z.string(),
  filename: z.string(),
  mime: z.string().default("application/octet-stream"),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
  uploadedAt: ts,
});
export type StoredFile = z.infer<typeof StoredFile>;

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
  /** the PRIMARY country (display name, or the region "Europe") — one per posting */
  country: z.string().nullable().default(null),
  /**
   * Every country (ISO-2, primary first) the location string places the role in: a
   * Greenhouse role with offices in Austin and London is ["US", "GB"]. Market matching and
   * the "abroad" checks consider any of them (`locationInCountry`). Absent on rows parsed
   * before it existed — readers fall back to `country`.
   */
  countries: z.array(z.string()).optional(),
  timezone: z.string().nullable().default(null),
  remoteGeo: RemoteGeo.default("unknown"),
  sponsorship: z.boolean().nullable().default(null),
  /**
   * 0..1 confidence in the parsed geo (§11.3). High = explicit city+country or an
   * unambiguous remote-geo; low = a bare/ambiguous string or a "remote" with
   * conflicting geo hints. Low confidence ⇒ the matcher surfaces an honest
   * "verify before applying" flag rather than scoring a guess as fact.
   */
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ParsedLocation = z.infer<typeof ParsedLocation>;

/**
 * Years-of-experience asked for, parsed deterministically from the JD (§11.2).
 * Both nullable: `min` open-ended lower bound ("3+ years"), `max` upper bound of a
 * range. A soft seniority signal only — never a hard exclusion (invariant #4).
 */
export const ExperienceRange = z.object({
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
});
export type ExperienceRange = z.infer<typeof ExperienceRange>;

export const SalaryBand = z.object({
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  currency: z.string().default("USD"),
  source: z.string().default("none"),
  confidence: SalaryConfidence.default("low"),
});
export type SalaryBand = z.infer<typeof SalaryBand>;

/**
 * A MODELED salary for a posting that states none (§11.4) — never fact. It lives apart
 * from `salary` (what the posting says) so a re-poll can't wipe it and nothing downstream
 * can mistake one for the other. `min`/`max` are the p25–p75 band, annual, in the posting's
 * market currency. `confidenceScore` (0..1) blends sample size, spread, how similar the
 * comparables are, and whether independent sources agree; its bucket `confidence` is capped
 * at "medium", so an estimate can never reach the hard salary floor (invariant #4).
 */
export const SalaryEstimate = z.object({
  min: z.number(),
  median: z.number(),
  max: z.number(),
  currency: z.string(),
  confidence: SalaryConfidence,
  confidenceScore: z.number().min(0).max(1),
  /** comparable posted salaries that carried weight */
  sampleCount: z.number().int(),
  /** each evidence source's own median and the weight it got in the blend */
  sources: z.array(
    z.object({ source: z.string(), median: z.number(), weight: z.number(), detail: z.string() }),
  ),
  /** one human line: "14 similar posted ranges in India (5 same level) · levels.fyi India" */
  basis: z.string(),
  computedAt: z.string(),
});
export type SalaryEstimate = z.infer<typeof SalaryEstimate>;

/**
 * A company's own pay data from a comp/reviews site — levels.fyi's per-country level ladder,
 * AmbitionBox CTC by designation (§11.5) — per role, so the estimator can price the matching
 * level instead of an all-roles average. One entry per (source, market); `roles: []` records
 * a miss so it isn't re-fetched every run.
 */
export const CompanyCompBenchmark = z.object({
  source: z.string(),
  currency: z.string(),
  /** the SalaryMarket the figures describe ("IN") */
  market: z.string(),
  /** what the figures measure: India CTC, levels.fyi total comp, or base */
  basis: z.enum(["ctc", "total_comp", "base"]),
  /** share of these figures a posting would state (base ÷ total comp), when the source says */
  postedShare: z.number().nullable().optional(),
  roles: z.array(
    z.object({
      title: z.string(),
      levelBand: LevelBand.nullable(),
      median: z.number(),
      lo: z.number().nullable(),
      hi: z.number().nullable(),
      n: z.number().int().nullable(),
    }),
  ),
  fetchedAt: z.string(),
});
export type CompanyCompBenchmark = z.infer<typeof CompanyCompBenchmark>;

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
  /** per-role pay from comp/review sites, one entry per source (AmbitionBox, §11.5) */
  compBenchmarks: z.array(CompanyCompBenchmark).optional(),
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
  /**
   * The source's own structured seniority (Himalayas "Mid-level", SmartRecruiters
   * "Entry Level"), used when the title carries no level (§11.2). Ambiguous source
   * buckets ("Mid-Senior") are left null rather than guessed.
   */
  levelHint: LevelBand.nullable().optional(),
  /**
   * The source's own structured years-of-experience range (Hirist/Cutshort/TimesJobs/
   * Instahyre/Wellfound/Zoho fields). It's what the recruiter filters candidates on,
   * so it wins over parsing JD prose (which carries boilerplate like "15 years full
   * time education").
   */
  experienceHint: ExperienceRange.optional(),
  /**
   * The source's own structured "posted by a consultancy / staffing intermediary" flag
   * (Naukri marks these). Prose regexes in the trust score catch the rest; this is the
   * version that doesn't depend on how the JD is worded.
   */
  postedByAgency: z.boolean().optional(),
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
  /**
   * The source's own location text as fetched ("Hybrid - Austin, TX; London, United
   * Kingdom"), kept so a parser fix can re-derive `location` from stored postings
   * (`renormalizePostings`) instead of waiting for a re-poll. Absent on older rows.
   */
  locationRaw: z.string().nullable().optional(),
  salary: SalaryBand,
  /**
   * The source's own salary text as fetched (Lever/Ashby/Naukri pay strings), kept so an
   * extractor fix can re-parse stored postings exactly instead of waiting for a re-poll.
   */
  salaryRaw: z.string().nullable().optional(),
  /** modeled pay when the posting states none (§11.4) — see SalaryEstimate */
  salaryEstimate: SalaryEstimate.nullable().optional(),
  /** years-of-experience the JD asks for (§11.2); {null,null} when unstated. */
  experience: ExperienceRange.default({ min: null, max: null }),

  applyUrl: z.string().nullable().default(null),
  /** a source flagged the poster as a consultancy / staffing intermediary (§11 trust). */
  postedByAgency: z.boolean().optional(),
  // embeddings live in pgvector; in JS we carry the array (or null until embedded)
  jdEmbedding: z.array(z.number()).nullable().default(null),
  /**
   * `{embedder id}:{hash of the embedded text}` for `jdEmbedding`. A re-poll whose key is
   * unchanged reuses the stored vector instead of paying for a new one; a different
   * embedder (switching LLM_PROVIDER) changes the key, so vectors never mix models.
   */
  embedKey: z.string().nullable().optional(),

  // lifecycle / freshness (§3)
  /**
   * When the SOURCE says the role was published (Greenhouse first_published, Lever
   * createdAt, Ashby publishedAt…). `firstSeen` is only when WE first saw it — a
   * 90-day-old req first polled today would otherwise read as brand new. Null when the
   * source gives no trustworthy publish date; freshness then falls back to firstSeen.
   */
  postedAt: ts.nullable().default(null),
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
  /** where the entry came from — `sample` entries are the fictional demo persona. */
  origin: EvidenceOrigin.default("manual"),
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
  currency: z.string().default("USD"),
  /**
   * ISO-3166 alpha-2 country the candidate lives/works in ("" = not set). Drives the
   * "onsite in my own country" check and default polling markets — nothing is assumed.
   */
  homeCountry: z.string().default(""),
  /** ISO-2 markets to search (boards polled per country, ad-hoc search defaults). [] → homeCountry. */
  markets: z.array(z.string()).default([]),
  contact: Contact.default({}),
  /** weighted ranked location prefs, not binary (§11.3) */
  locationWeights: z
    .array(z.object({ label: z.string(), weight: z.number() }))
    .default([]),
  stackMustHaves: z.array(z.string()).default([]),
  stackProfile: z.array(z.string()).default([]),
  remoteGeoOk: z.array(RemoteGeo).default(["worldwide"]),
  relocate: z.boolean().default(false),
  targetArchetypes: z.array(RoleArchetype).default([]),
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
  /** set when the user finished onboarding (web wizard / `jobflow init`); null = not yet. */
  onboardedAt: ts.nullable().default(null),
  /** the uploaded base résumé file (stored outside the repo tree), if any. */
  resumeFile: StoredFile.nullable().default(null),
});
export type Profile = z.infer<typeof Profile>;

// ── Generation — a cached, evidence-grounded draft (resume variants / answers, §4) ──
/** `resume` content is JSON.stringify(ResumeVariants); `cover_letter` is JSON of
 *  {text, note}; the rest are plain text (a .tex / Markdown document, or an answer). */
export const GenerationKind = z.enum([
  "resume",
  "resume_latex",
  "resume_md",
  "cover_letter",
  "why_here",
  "interesting_problem",
  "about_blurb",
  "answer",
  /** the LLM re-rank write-up for a top match (§11.6), JSON — cached per posting, not a draft */
  "rerank",
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
  /** display label (e.g. "github.com/octocat"). */
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
  /** source prior × listing signals (§3) — older match rows predate it. */
  sourceTrust: z.number().default(0.7),
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
  /**
   * built-in discovery presets switched on (`india`, `global-remote`, `us`, `eu-uk`) —
   * several at once; custom sources add to them. [] → the legacy single `discoveryPreset`.
   */
  discoveryPresets: z.array(z.string()).default([]),
  /** legacy single preset (pre-multi-select rows); read through `activePresets()`. */
  discoveryPreset: z.string().default("india"),
  /** preset feed ids this tenant switched off. */
  presetFeedsDisabled: z.array(z.string()).default([]),
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

/** Where a saved cover letter lives in `Application.answers`; the agent maps it to the
 *  form's cover-letter field rather than fuzzy-matching it as a free-text question. */
export const COVER_LETTER_ANSWER_KEY = "cover letter";

/** The presets a tenant has switched on (multi-select), falling back to the legacy single one. */
export function activePresets(c: Pick<TenantConfig, "discoveryPresets" | "discoveryPreset"> | null | undefined): string[] {
  if (!c) return ["india"];
  const list = (c.discoveryPresets ?? []).filter(Boolean);
  return list.length ? [...new Set(list)] : [c.discoveryPreset || "india"];
}
