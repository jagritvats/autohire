import type {
  AgentHeartbeat,
  Application,
  Company,
  ConnectedContext,
  Evidence,
  Generation,
  GenerationKind,
  Job,
  ProfileSourceKind,
  JobRuntime,
  JobStatus,
  JobType,
  Match,
  Posting,
  Profile,
  SalaryBand,
  TenantConfig,
} from "@jobflow/core";

/**
 * Storage-agnostic repository. The pipeline, API, and CLI depend only on this
 * interface; the in-memory impl powers the CLI/tests with zero infra, the Supabase
 * impl powers production. Swapping is a one-line change in composition.
 *
 * `tenantId` is threaded everywhere user-scoped — mirrors the RLS boundary (§6.1)
 * so app code can't accidentally cross tenants even before RLS kicks in.
 */
export interface Repository {
  // ── companies (shared global) ──
  upsertCompany(c: UpsertCompany): Promise<Company>;
  getCompany(id: string): Promise<Company | null>;
  findCompanyByNameNorm(nameNorm: string): Promise<Company | null>;
  listCompanies(filter?: { status?: string; dueForPoll?: boolean }): Promise<Company[]>;
  touchPolled(companyId: string): Promise<void>;
  /** persist enrichment (comp benchmark / ratings) onto a company (§11.4-5). */
  saveCompanyEnrichment(id: string, patch: CompanyEnrichmentPatch): Promise<void>;
  updateCompany(id: string, patch: { status?: Company["status"]; pollCadence?: Company["pollCadence"]; tags?: string[] }): Promise<void>;
  deleteCompany(id: string): Promise<void>;
  /** active posting counts grouped by company id (for the registry UI). */
  postingCountsByCompany(): Promise<Record<string, number>>;

  // ── postings (shared global) ──
  /** idempotent upsert keyed on (atsType, atsJobId); bumps lastSeen / repostCount (§3). */
  upsertPosting(p: NewPosting): Promise<Posting>;
  getPosting(id: string): Promise<Posting | null>;
  listActivePostings(): Promise<Posting[]>;
  listPostingsByCompany(companyId: string): Promise<Posting[]>;
  setCanonical(postingId: string, canonicalId: string): Promise<void>;
  /** fill an estimated salary band on a posting that lacks a direct one (§11.4). */
  updatePostingSalary(id: string, band: SalaryBand): Promise<void>;
  /** soft-delete postings not seen in this poll of a company (role filled/pulled). */
  markStale(companyId: string, seenAtsJobIds: string[]): Promise<number>;

  // ── posting lifecycle (manual, shared-global; §3) ──
  /** manually mark a posting invalid (spam/dupe/fake) with a reason — reversible. */
  invalidatePosting(id: string, reason: string): Promise<void>;
  /** undo an invalidation → back to active (no-op if it wasn't invalidated). */
  revalidatePosting(id: string): Promise<void>;
  listInvalidatedPostings(): Promise<Posting[]>;
  /**
   * Bulk soft-delete (default) or hard-purge postings older than a threshold, by
   * `lastSeen` (default) or `firstSeen`. Soft = mark stale + inactive; hard = delete.
   * Never touches invalidated postings (a manual decision outranks age). Returns count.
   */
  purgeOldPostings(opts: PurgeOptions): Promise<number>;

  // ── profile / config / evidence (tenant-scoped) ──
  getProfile(tenantId: string): Promise<Profile | null>;
  saveProfile(p: Profile): Promise<Profile>;
  getConfig(tenantId: string): Promise<TenantConfig | null>;
  saveConfig(c: TenantConfig): Promise<TenantConfig>;
  listEvidence(tenantId: string): Promise<Evidence[]>;
  /** upsert by id (create or edit a Bank entry from the settings editor). */
  saveEvidence(e: Evidence): Promise<Evidence>;
  deleteEvidence(tenantId: string, id: string): Promise<void>;

  // ── per-user posting overlay: archive + bookmark (tenant-scoped, §5/§6.1) ──
  /** archive/unarchive a posting for this tenant — retained but hidden from the feed. */
  setPostingArchived(tenantId: string, postingId: string, archived: boolean): Promise<void>;
  /** bookmark/unbookmark a posting for this tenant. */
  setPostingBookmarked(tenantId: string, postingId: string, bookmarked: boolean): Promise<void>;
  listArchivedPostings(tenantId: string): Promise<Posting[]>;
  listBookmarkedPostings(tenantId: string): Promise<Posting[]>;
  /** the tenant's archived/bookmarked posting-id sets — for feed filtering + badges. */
  getPostingUserState(tenantId: string): Promise<{ archived: Set<string>; bookmarked: Set<string> }>;

  // ── matches (tenant-scoped) ──
  saveMatches(matches: Match[]): Promise<void>;
  listMatches(tenantId: string, limit?: number): Promise<Array<Match & { posting: Posting }>>;
  /** matches for a specific posting set (enriches archived/bookmark views with score). */
  listMatchesForPostings(tenantId: string, postingIds: string[]): Promise<Match[]>;

  // ── salary cache (memoize role+location lookups with TTL, §11.4) ──
  getSalaryCache(key: string): Promise<SalaryCacheEntry | null>;
  putSalaryCache(entry: SalaryCacheEntry): Promise<void>;

  // ── generation cache (evidence-grounded drafts; §4 "Customize") ──
  /** latest draft for a (tenant, posting|null, kind, prompt) slot — the cache lookup. */
  getGeneration(tenantId: string, postingId: string | null, kind: GenerationKind, prompt?: string): Promise<Generation | null>;
  listGenerations(tenantId: string, postingId?: string | null): Promise<Generation[]>;
  /** replace-the-slot upsert: one row per (tenant, posting, kind, prompt). */
  saveGeneration(g: Generation): Promise<Generation>;
  /** force-refresh: drop cached drafts (all, or just one posting's). */
  clearGenerations(tenantId: string, opts?: { postingId?: string | null }): Promise<number>;

  // ── connected context (read-only profile imports; §4) ──
  listContexts(tenantId: string): Promise<ConnectedContext[]>;
  getContext(tenantId: string, source: ProfileSourceKind): Promise<ConnectedContext | null>;
  /** replace-the-slot upsert: one row per (tenant, source). */
  upsertContext(c: ConnectedContext): Promise<ConnectedContext>;
  setContextEnabled(tenantId: string, source: ProfileSourceKind, enabled: boolean): Promise<void>;
  deleteContext(tenantId: string, source: ProfileSourceKind): Promise<void>;

  // ── applications / CRM (tenant-scoped) ──
  upsertApplication(a: Application): Promise<Application>;
  listApplications(tenantId: string): Promise<Application[]>;
  listApplicationsWithPosting(tenantId: string): Promise<Array<Application & { posting: Posting | null }>>;
  getApplicationByPosting(tenantId: string, postingId: string): Promise<Application | null>;
  /** dedup keys of postings already applied to (don't-double-apply guard, §7). */
  appliedDedupKeys(tenantId: string): Promise<Set<string>>;

  // ── command plane: jobs (the web enqueues; worker/agent drain) ──
  enqueueJob(input: EnqueueJob): Promise<Job>;
  /** atomically claim the oldest queued job for a runtime → status=running. */
  claimJob(runtime: JobRuntime): Promise<Job | null>;
  completeJob(id: string, status: Extract<JobStatus, "done" | "error">, payload: { result?: Record<string, unknown>; error?: string }): Promise<void>;
  listJobs(tenantId: string, limit?: number): Promise<Job[]>;

  // ── local-agent heartbeat (§7.1) ──
  upsertHeartbeat(h: AgentHeartbeat): Promise<void>;
  getHeartbeat(tenantId: string): Promise<AgentHeartbeat | null>;
}

export interface EnqueueJob {
  tenantId: string;
  type: JobType;
  runtime: JobRuntime;
  payload?: Record<string, unknown>;
}

export interface PurgeOptions {
  /** age threshold in days. */
  olderThanDays: number;
  /** which timestamp to compare against (default lastSeen). */
  field?: "lastSeen" | "firstSeen";
  /** true → DELETE the rows; false/undefined → soft-delete (mark stale + inactive). */
  hard?: boolean;
}

export interface CompanyEnrichmentPatch {
  compMedian?: number | null;
  compCurrency?: string | null;
  compSource?: string | null;
  compBreakdown?: Array<{ family: string; median: number }> | null;
  ratingOverall?: number | null;
  ratingWlb?: number | null;
  ratingComp?: number | null;
  reviewCount?: number | null;
  ratingSource?: string | null;
  cultureSummary?: string | null;
  interviewDifficulty?: string | null;
}

export interface SalaryCacheEntry {
  key: string;
  roleArchetype?: string | null;
  location?: string | null;
  estMin: number | null;
  estMax: number | null;
  currency: string;
  source: string;
  confidence: string;
  /** ttl in days */
  ttlDays?: number;
}

export interface UpsertCompany {
  name: string;
  nameNorm: string;
  atsType?: Company["atsType"];
  atsSlug?: string | null;
  careersUrl?: string | null;
  tags?: string[];
  pollCadence?: Company["pollCadence"];
}

/** Fields the pipeline supplies; repo assigns id/firstSeen/lastSeen/isActive/lifecycle. */
export interface NewPosting
  extends Omit<
    Posting,
    "id" | "firstSeen" | "lastSeen" | "isActive" | "repostCount" | "canonicalId" | "status" | "invalidReason" | "invalidatedAt"
  > {}
