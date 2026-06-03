import type {
  Application,
  Company,
  Evidence,
  Match,
  Posting,
  Profile,
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
  findCompanyByNameNorm(nameNorm: string): Promise<Company | null>;
  listCompanies(filter?: { status?: string; dueForPoll?: boolean }): Promise<Company[]>;
  touchPolled(companyId: string): Promise<void>;

  // ── postings (shared global) ──
  /** idempotent upsert keyed on (atsType, atsJobId); bumps lastSeen / repostCount (§3). */
  upsertPosting(p: NewPosting): Promise<Posting>;
  getPosting(id: string): Promise<Posting | null>;
  listActivePostings(): Promise<Posting[]>;
  setCanonical(postingId: string, canonicalId: string): Promise<void>;
  /** soft-delete postings not seen in this poll of a company (role filled/pulled). */
  markStale(companyId: string, seenAtsJobIds: string[]): Promise<number>;

  // ── profile / evidence (tenant-scoped) ──
  getProfile(tenantId: string): Promise<Profile | null>;
  saveProfile(p: Profile): Promise<Profile>;
  listEvidence(tenantId: string): Promise<Evidence[]>;
  saveEvidence(e: Evidence): Promise<Evidence>;

  // ── matches (tenant-scoped) ──
  saveMatches(matches: Match[]): Promise<void>;
  listMatches(tenantId: string, limit?: number): Promise<Array<Match & { posting: Posting }>>;

  // ── applications / CRM (tenant-scoped) ──
  upsertApplication(a: Application): Promise<Application>;
  listApplications(tenantId: string): Promise<Application[]>;
  /** dedup keys of postings already applied to (don't-double-apply guard, §7). */
  appliedDedupKeys(tenantId: string): Promise<Set<string>>;
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

/** Fields the pipeline supplies; repo assigns id/firstSeen/lastSeen/isActive. */
export interface NewPosting
  extends Omit<Posting, "id" | "firstSeen" | "lastSeen" | "isActive" | "repostCount" | "canonicalId"> {}
