import type {
  AgentHeartbeat,
  ApiToken,
  DiscoverySource,
  SavedSearch,
  Session,
  Tenant,
  User,
  UserRole,
  Application,
  Company,
  CompanyCompBenchmark,
  ConnectedContext,
  Evidence,
  ParsedLocation,
  ExperienceRange,
  LevelBand,
  Requirement,
  RoleArchetype,
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
  SalaryEstimate,
  SyncRunRecord,
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
  /**
   * Point a duplicate at its cluster's canonical posting, or clear the pointer with null
   * (the posting is its own canonical again: its cluster split, or the winner went stale).
   */
  setCanonical(postingId: string, canonicalId: string | null): Promise<void>;
  /**
   * Rewrite a posting's STATED salary (a re-parse after an extractor fix, §11.4). Estimates
   * never go here — they're `saveSalaryEstimates`.
   */
  updatePostingSalary(id: string, band: SalaryBand, salaryRaw?: string | null): Promise<void>;
  /**
   * Rewrite a posting's derived fields (a re-normalize after a parser fix,
   * `renormalizePostings`): location + agency flag always; the title / JD derivations when
   * given (omitted ones stay as stored). Never touches lifecycle columns (lastSeen, status…).
   */
  updatePostingNormalized(id: string, patch: PostingNormalizedPatch): Promise<void>;
  /** set (or clear, with null) the modeled salary on many postings in one write. */
  saveSalaryEstimates(updates: Array<{ id: string; estimate: SalaryEstimate | null }>): Promise<number>;
  /** soft-delete postings not seen in this poll of a company (role filled/pulled). */
  markStale(companyId: string, seenAtsJobIds: string[]): Promise<number>;
  /**
   * Re-confirm postings as still live (bump lastSeen) without re-writing them — for
   * boards whose poll returned a lite listing (no JD) for already-stored postings.
   */
  touchSeen(companyId: string, atsJobIds: string[]): Promise<void>;
  /** stored postings for these (atsType, atsJobId) keys — any status (embedding reuse). */
  findPostingsByAtsIds(atsType: Posting["atsType"], atsJobIds: string[]): Promise<Posting[]>;
  /**
   * Soft-delete specific postings their source DEFINITIVELY reported gone (a per-job
   * 404/410 from the liveness check) — the per-posting twin of `markStale`, never driven
   * by an error or a partial fetch (§3). Invalidated postings keep their status. Returns count.
   */
  retirePostings(ids: string[]): Promise<number>;

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

  // ── store metadata (shared global key → value, e.g. `normalize_version`; no TTL) ──
  getStoreMeta(key: string): Promise<string | null>;
  setStoreMeta(key: string, value: string): Promise<void>;

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
  /**
   * atomically claim the oldest queued job for a runtime → status=running. `tenantId`
   * restricts the claim to one tenant's jobs (a local agent only ever drains its own).
   */
  claimJob(runtime: JobRuntime, opts?: { tenantId?: string }): Promise<Job | null>;
  /**
   * re-queue jobs stuck in `running` longer than `olderThanMinutes` (the process that
   * claimed them died). Returns how many were re-queued.
   */
  requeueStuckJobs(runtime: JobRuntime, olderThanMinutes: number): Promise<number>;
  completeJob(id: string, status: Extract<JobStatus, "done" | "error">, payload: { result?: Record<string, unknown>; error?: string }): Promise<void>;
  listJobs(tenantId: string, limit?: number): Promise<Job[]>;

  // ── local-agent heartbeat (§7.1) ──
  upsertHeartbeat(h: AgentHeartbeat): Promise<void>;
  getHeartbeat(tenantId: string): Promise<AgentHeartbeat | null>;

  // ── tenants + accounts (per-user capability) ──
  /** create a tenant; `id` lets the first signup claim the default tenant. */
  createTenant(input: { name: string; id?: string }): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | null>;
  /** tenants, optionally only those active in the last N days (worker rank fan-out). */
  listTenants(opts?: { activeSinceDays?: number }): Promise<Tenant[]>;
  touchTenantActive(id: string): Promise<void>;
  createUser(input: { tenantId: string; email: string; passwordHash: string | null; role: UserRole }): Promise<User>;
  countUsers(): Promise<number>;
  /** case-insensitive lookup; the only method that returns the password hash. */
  findUserByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null>;
  getUser(id: string): Promise<User | null>;
  setUserPassword(id: string, passwordHash: string): Promise<void>;

  // ── sessions + API tokens (secrets stored as sha256 only) ──
  createSession(s: Session & { secretHash: string }): Promise<void>;
  getSession(id: string): Promise<(Session & { secretHash: string }) | null>;
  touchSession(id: string, expiresAt: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** revoke every session of a user (password change), optionally keeping one. */
  deleteUserSessions(userId: string, exceptId?: string): Promise<number>;
  createApiToken(t: ApiToken & { secretHash: string }): Promise<void>;
  getApiToken(id: string): Promise<(ApiToken & { secretHash: string }) | null>;
  listApiTokens(tenantId: string): Promise<ApiToken[]>;
  /** true if a live token of this tenant was revoked. */
  revokeApiToken(tenantId: string, id: string): Promise<boolean>;
  touchApiToken(id: string): Promise<void>;

  // ── saved searches (tenant-scoped) ──
  listSavedSearches(tenantId: string): Promise<SavedSearch[]>;
  getSavedSearch(tenantId: string, id: string): Promise<SavedSearch | null>;
  /** upsert by id; names are unique per tenant. */
  saveSavedSearch(s: SavedSearch): Promise<SavedSearch>;
  deleteSavedSearch(tenantId: string, id: string): Promise<void>;
  recordSavedSearchRun(tenantId: string, id: string, result: Record<string, unknown>): Promise<void>;
  /** every enabled source-search across tenants (the cron's union). */
  listAllSourceSearches(): Promise<SavedSearch[]>;

  // ── custom discovery sources (tenant-scoped config; the postings they find are global) ──
  listDiscoverySources(tenantId: string): Promise<DiscoverySource[]>;
  /** upsert by id; (tenant, configKey) is unique. */
  saveDiscoverySource(s: DiscoverySource): Promise<DiscoverySource>;
  deleteDiscoverySource(tenantId: string, id: string): Promise<void>;
  recordDiscoverySourceRun(
    id: string,
    run: { status: "ok" | "empty" | "error"; count: number; error?: string | null },
  ): Promise<void>;
  /** every enabled custom source across tenants (deduped by configKey in the pipeline). */
  listAllEnabledDiscoverySources(): Promise<DiscoverySource[]>;

  // ── company follows (tenant-scoped overlay on the global registry) ──
  followCompany(tenantId: string, companyId: string): Promise<void>;
  unfollowCompany(tenantId: string, companyId: string): Promise<void>;
  listFollowedCompanyIds(tenantId: string): Promise<string[]>;

  // ── sync runs (global: the corpus is shared; per-tenant entries are filtered by the service) ──
  /** insert or replace a run by id; only the newest SYNC_RUNS_KEPT are kept. */
  saveSyncRun(run: SyncRunRecord): Promise<void>;
  /** newest first */
  listSyncRuns(limit?: number): Promise<SyncRunRecord[]>;
}

/** what a re-normalize rewrites on a stored posting (`updatePostingNormalized`). */
export interface PostingNormalizedPatch {
  location: ParsedLocation;
  postedByAgency: boolean;
  /** the title as a person reads it (entities decoded) and what it derives */
  title?: string;
  titleNorm?: string;
  roleArchetype?: RoleArchetype;
  levelBand?: LevelBand | null;
  /** the JD as plain text (markup / entities cleaned) and what it derives */
  jdText?: string;
  jdSkills?: string[];
  requirements?: Requirement[];
  experience?: ExperienceRange;
  /** the stage-1 dedup key recomputed from the above (the don't-double-apply guard reads it) */
  dedupKey?: string;
}

/** sync-run history kept in the store (older rows are pruned on save) */
export const SYNC_RUNS_KEPT = 50;

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
  /**
   * limit to postings from these sources. Aggregator/HN postings have no per-company
   * board to diff against, so `markStale` never retires them — a lastSeen TTL scoped to
   * those sources is how they expire (§3).
   */
  sources?: string[];
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
  /** per-role pay from one source for one market; replaces that pair's previous entry (§11.5) */
  compBenchmark?: CompanyCompBenchmark | null;
}

export interface SalaryCacheEntry {
  key: string;
  roleArchetype?: string | null;
  location?: string | null;
  estMin: number | null;
  estMax: number | null;
  /** the benchmark's own median (p25/p75 are estMin/estMax) */
  estMedian?: number | null;
  /** how many salaries the benchmark summarizes */
  sampleCount?: number | null;
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
