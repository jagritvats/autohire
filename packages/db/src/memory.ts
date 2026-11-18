import { randomUUID } from "node:crypto";
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
  ConnectedContext,
  Evidence,
  ParsedLocation,
  Generation,
  GenerationKind,
  Job,
  ProfileSourceKind,
  JobRuntime,
  JobStatus,
  Match,
  Posting,
  Profile,
  SalaryBand,
  SalaryEstimate,
  TenantConfig,
} from "@jobflow/core";
import type {
  CompanyEnrichmentPatch,
  EnqueueJob,
  NewPosting,
  PurgeOptions,
  Repository,
  SalaryCacheEntry,
  UpsertCompany,
} from "./repository.js";

/**
 * In-memory repository — powers the CLI demo and unit tests with zero infra.
 * Implements the same idempotency/freshness semantics as the Supabase impl so
 * behavior is identical; just not durable.
 */
export class InMemoryRepository implements Repository {
  private companies = new Map<string, Company>();
  private companyByNorm = new Map<string, string>();
  private postings = new Map<string, Posting>();
  private postingByAtsKey = new Map<string, string>(); // `${atsType}:${atsJobId}`
  private profiles = new Map<string, Profile>();
  private configs = new Map<string, TenantConfig>();
  private evidence = new Map<string, Evidence[]>();
  private matches = new Map<string, Match[]>();
  private applications = new Map<string, Application[]>();
  private jobs: Job[] = [];
  private heartbeats = new Map<string, AgentHeartbeat>();
  private salaryCache = new Map<string, SalaryCacheEntry & { fetchedAt: number }>();
  private storeMeta = new Map<string, string>();
  private generations: Generation[] = [];
  private contexts = new Map<string, ConnectedContext>(); // key: `${tenantId}:${source}`
  // per-user posting overlay (archive + bookmark), key: `${tenantId}:${postingId}`
  private postingState = new Map<string, { archived: boolean; bookmarked: boolean }>();
  // per-user capability: tenants, accounts, sessions, tokens
  private tenants = new Map<string, Tenant>([
    ["00000000-0000-0000-0000-000000000001", { id: "00000000-0000-0000-0000-000000000001", name: "default", createdAt: new Date(0), lastActiveAt: null }],
  ]);
  private users = new Map<string, User & { passwordHash: string | null }>();
  private sessions = new Map<string, Session & { secretHash: string }>();
  private tokens = new Map<string, ApiToken & { secretHash: string }>();
  private savedSearches = new Map<string, SavedSearch>();
  private discoverySources = new Map<string, DiscoverySource>();
  private follows = new Map<string, Set<string>>(); // tenantId → companyIds

  async upsertCompany(c: UpsertCompany): Promise<Company> {
    const existingId = this.companyByNorm.get(c.nameNorm);
    if (existingId) {
      const existing = this.companies.get(existingId)!;
      const merged: Company = {
        ...existing,
        atsType: c.atsType && c.atsType !== "unknown" ? c.atsType : existing.atsType,
        atsSlug: c.atsSlug ?? existing.atsSlug,
        careersUrl: c.careersUrl ?? existing.careersUrl,
        tags: [...new Set([...existing.tags, ...(c.tags ?? [])])],
        pollCadence: c.pollCadence ?? existing.pollCadence,
      };
      this.companies.set(existingId, merged);
      return merged;
    }
    const company: Company = {
      id: randomUUID(),
      name: c.name,
      nameNorm: c.nameNorm,
      atsType: c.atsType ?? "unknown",
      atsSlug: c.atsSlug ?? null,
      careersUrl: c.careersUrl ?? null,
      fundingStage: null,
      tags: c.tags ?? [],
      pollCadence: c.pollCadence ?? "weekly",
      lastPolled: null,
      status: "active",
      ratingOverall: null,
      ratingWlb: null,
      ratingComp: null,
      reviewCount: null,
      ratingSource: null,
      cultureSummary: null,
      interviewDifficulty: null,
      compMedian: null,
      compCurrency: null,
      compSource: null,
      compBreakdown: null,
      compUpdatedAt: null,
      enrichedAt: null,
      createdAt: new Date(),
    };
    this.companies.set(company.id, company);
    this.companyByNorm.set(c.nameNorm, company.id);
    return company;
  }

  async getCompany(id: string): Promise<Company | null> {
    return this.companies.get(id) ?? null;
  }
  async findCompanyByNameNorm(nameNorm: string): Promise<Company | null> {
    const id = this.companyByNorm.get(nameNorm);
    return id ? (this.companies.get(id) ?? null) : null;
  }
  async saveCompanyEnrichment(id: string, patch: CompanyEnrichmentPatch): Promise<void> {
    const c = this.companies.get(id);
    if (!c) return;
    Object.assign(c, {
      ...(patch.compMedian !== undefined ? { compMedian: patch.compMedian } : {}),
      ...(patch.compCurrency !== undefined ? { compCurrency: patch.compCurrency } : {}),
      ...(patch.compSource !== undefined ? { compSource: patch.compSource } : {}),
      ...(patch.compBreakdown !== undefined ? { compBreakdown: patch.compBreakdown } : {}),
      ...(patch.ratingOverall !== undefined ? { ratingOverall: patch.ratingOverall } : {}),
      ...(patch.ratingWlb !== undefined ? { ratingWlb: patch.ratingWlb } : {}),
      ...(patch.ratingComp !== undefined ? { ratingComp: patch.ratingComp } : {}),
      ...(patch.reviewCount !== undefined ? { reviewCount: patch.reviewCount } : {}),
      ...(patch.ratingSource !== undefined ? { ratingSource: patch.ratingSource } : {}),
      ...(patch.cultureSummary !== undefined ? { cultureSummary: patch.cultureSummary } : {}),
      ...(patch.interviewDifficulty !== undefined ? { interviewDifficulty: patch.interviewDifficulty } : {}),
      ...(patch.compBenchmark
        ? {
            // one entry per (source, market): the new one replaces that pair's previous entry
            compBenchmarks: [
              ...(c.compBenchmarks ?? []).filter((b) => !(b.source === patch.compBenchmark!.source && b.market === patch.compBenchmark!.market)),
              patch.compBenchmark,
            ],
          }
        : {}),
      compUpdatedAt: new Date(),
      enrichedAt: new Date(),
    });
  }

  async listCompanies(filter?: { status?: string; dueForPoll?: boolean }): Promise<Company[]> {
    let all = [...this.companies.values()];
    if (filter?.status) all = all.filter((c) => c.status === filter.status);
    if (filter?.dueForPoll) all = all.filter((c) => isDue(c));
    return all;
  }

  async touchPolled(companyId: string): Promise<void> {
    const c = this.companies.get(companyId);
    if (c) c.lastPolled = new Date();
  }
  async updateCompany(
    id: string,
    patch: { status?: Company["status"]; pollCadence?: Company["pollCadence"]; tags?: string[] },
  ): Promise<void> {
    const c = this.companies.get(id);
    if (!c) return;
    if (patch.status) c.status = patch.status;
    if (patch.pollCadence) c.pollCadence = patch.pollCadence;
    if (patch.tags) c.tags = patch.tags;
  }
  async deleteCompany(id: string): Promise<void> {
    const c = this.companies.get(id);
    if (c) this.companyByNorm.delete(c.nameNorm);
    this.companies.delete(id);
    for (const [pid, p] of this.postings) if (p.companyId === id) this.postings.delete(pid);
  }
  async postingCountsByCompany(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const p of this.postings.values()) {
      if (p.isActive && p.status === "active") counts[p.companyId] = (counts[p.companyId] ?? 0) + 1;
    }
    return counts;
  }

  async upsertPosting(p: NewPosting): Promise<Posting> {
    const key = `${p.atsType}:${p.atsJobId}`;
    const existingId = this.postingByAtsKey.get(key);
    const now = new Date();
    if (existingId) {
      const existing = this.postings.get(existingId)!;
      const reposted = existing.titleNorm !== p.titleNorm || isRedated(existing, p.postedAt); // same rules as PgRepository
      const updated: Posting = {
        ...existing,
        ...p,
        // keep the ORIGINAL publish date: a repost re-stamps the source's date (§3)
        postedAt: earlierDate(existing.postedAt, p.postedAt),
        // identity stays with the first write, like PgRepository's upsert; content (the
        // dedup key and company spelling included) is refreshed by the spread above
        id: existing.id,
        companyId: existing.companyId,
        source: existing.source,
        tier: existing.tier,
        firstSeen: existing.firstSeen,
        lastSeen: now,
        isActive: true,
        repostCount: existing.repostCount + (reposted ? 1 : 0),
        canonicalId: existing.canonicalId,
        salaryEstimate: existing.salaryEstimate ?? null, // the estimator's, not the poll's
        // re-seen → clear staleness, but a manual `invalidated` decision persists (§3).
        status: existing.status === "stale" ? "active" : existing.status,
        invalidReason: existing.invalidReason,
        invalidatedAt: existing.invalidatedAt,
      };
      this.postings.set(existing.id, updated);
      return updated;
    }
    const posting: Posting = {
      ...p,
      id: randomUUID(),
      firstSeen: now,
      lastSeen: now,
      isActive: true,
      repostCount: 0,
      canonicalId: null,
      status: "active",
      invalidReason: null,
      invalidatedAt: null,
    };
    this.postings.set(posting.id, posting);
    this.postingByAtsKey.set(key, posting.id);
    return posting;
  }

  async getPosting(id: string): Promise<Posting | null> {
    return this.postings.get(id) ?? null;
  }

  async listActivePostings(): Promise<Posting[]> {
    return [...this.postings.values()].filter((p) => p.isActive && p.status === "active");
  }
  async listPostingsByCompany(companyId: string): Promise<Posting[]> {
    return [...this.postings.values()].filter(
      (p) => p.companyId === companyId && p.isActive && p.status === "active",
    );
  }

  async setCanonical(postingId: string, canonicalId: string | null): Promise<void> {
    const p = this.postings.get(postingId);
    if (p) p.canonicalId = canonicalId;
  }
  async saveSalaryEstimates(updates: Array<{ id: string; estimate: SalaryEstimate | null }>): Promise<number> {
    let n = 0;
    for (const u of updates) {
      const p = this.postings.get(u.id);
      if (!p) continue;
      p.salaryEstimate = u.estimate;
      n++;
    }
    return n;
  }
  async updatePostingNormalized(id: string, patch: { location: ParsedLocation; postedByAgency: boolean }): Promise<void> {
    const p = this.postings.get(id);
    if (!p) return;
    p.location = patch.location;
    p.postedByAgency = patch.postedByAgency;
  }
  async updatePostingSalary(id: string, band: SalaryBand, salaryRaw?: string | null): Promise<void> {
    const p = this.postings.get(id);
    if (!p) return;
    p.salary = band;
    if (salaryRaw !== undefined) p.salaryRaw = salaryRaw;
  }

  async markStale(companyId: string, seenAtsJobIds: string[]): Promise<number> {
    const seen = new Set(seenAtsJobIds);
    let n = 0;
    for (const p of this.postings.values()) {
      if (p.companyId === companyId && p.isActive && !seen.has(p.atsJobId)) {
        p.isActive = false;
        // preserve a manual invalidation; otherwise reflect staleness in the status.
        if (p.status !== "invalidated") p.status = "stale";
        n++;
      }
    }
    return n;
  }

  async touchSeen(companyId: string, atsJobIds: string[]): Promise<void> {
    const ids = new Set(atsJobIds);
    const now = new Date();
    for (const p of this.postings.values()) {
      if (p.companyId !== companyId || !ids.has(p.atsJobId)) continue;
      p.lastSeen = now;
      p.isActive = true;
      if (p.status === "stale") p.status = "active";
    }
  }

  async findPostingsByAtsIds(atsType: Posting["atsType"], atsJobIds: string[]): Promise<Posting[]> {
    return atsJobIds
      .map((id) => this.postingByAtsKey.get(`${atsType}:${id}`))
      .filter((id): id is string => !!id)
      .map((id) => this.postings.get(id)!);
  }
  async retirePostings(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const p = this.postings.get(id);
      if (!p || !p.isActive) continue;
      p.isActive = false;
      if (p.status !== "invalidated") p.status = "stale";
      n++;
    }
    return n;
  }

  // ── posting lifecycle (manual, global) ──
  async invalidatePosting(id: string, reason: string): Promise<void> {
    const p = this.postings.get(id);
    if (!p) return;
    p.status = "invalidated";
    p.invalidReason = reason;
    p.invalidatedAt = new Date();
  }
  async revalidatePosting(id: string): Promise<void> {
    const p = this.postings.get(id);
    if (!p || p.status !== "invalidated") return;
    // re-seen since? isActive tells us whether it's still on the board.
    p.status = p.isActive ? "active" : "stale";
    p.invalidReason = null;
    p.invalidatedAt = null;
  }
  async listInvalidatedPostings(): Promise<Posting[]> {
    return [...this.postings.values()].filter((p) => p.status === "invalidated");
  }
  async purgeOldPostings(opts: PurgeOptions): Promise<number> {
    const field = opts.field ?? "lastSeen";
    const cutoff = Date.now() - opts.olderThanDays * 86_400_000;
    const sources = opts.sources?.length ? new Set(opts.sources) : null;
    let n = 0;
    for (const p of [...this.postings.values()]) {
      if (p.status === "invalidated") continue; // a manual decision outranks age
      if (sources && !sources.has(p.source)) continue;
      const t = new Date(p[field] as string | Date).getTime();
      if (t >= cutoff) continue;
      if (opts.hard) {
        this.postings.delete(p.id);
        this.postingByAtsKey.delete(`${p.atsType}:${p.atsJobId}`);
      } else {
        if (!p.isActive && p.status === "stale") continue; // already soft-deleted
        p.isActive = false;
        p.status = "stale";
      }
      n++;
    }
    return n;
  }

  // ── per-user posting overlay (archive + bookmark) ──
  private stateFor(tenantId: string, postingId: string) {
    const key = `${tenantId}:${postingId}`;
    let s = this.postingState.get(key);
    if (!s) {
      s = { archived: false, bookmarked: false };
      this.postingState.set(key, s);
    }
    return s;
  }
  async setPostingArchived(tenantId: string, postingId: string, archived: boolean): Promise<void> {
    this.stateFor(tenantId, postingId).archived = archived;
  }
  async setPostingBookmarked(tenantId: string, postingId: string, bookmarked: boolean): Promise<void> {
    this.stateFor(tenantId, postingId).bookmarked = bookmarked;
  }
  async getPostingUserState(tenantId: string): Promise<{ archived: Set<string>; bookmarked: Set<string> }> {
    const archived = new Set<string>();
    const bookmarked = new Set<string>();
    for (const [key, s] of this.postingState) {
      if (!key.startsWith(`${tenantId}:`)) continue;
      const postingId = key.slice(tenantId.length + 1);
      if (s.archived) archived.add(postingId);
      if (s.bookmarked) bookmarked.add(postingId);
    }
    return { archived, bookmarked };
  }
  async listArchivedPostings(tenantId: string): Promise<Posting[]> {
    const { archived } = await this.getPostingUserState(tenantId);
    return [...archived].map((id) => this.postings.get(id)).filter((p): p is Posting => !!p);
  }
  async listBookmarkedPostings(tenantId: string): Promise<Posting[]> {
    const { bookmarked } = await this.getPostingUserState(tenantId);
    return [...bookmarked].map((id) => this.postings.get(id)).filter((p): p is Posting => !!p);
  }

  async getProfile(tenantId: string): Promise<Profile | null> {
    return this.profiles.get(tenantId) ?? null;
  }
  async saveProfile(p: Profile): Promise<Profile> {
    this.profiles.set(p.tenantId, p);
    return p;
  }
  async getConfig(tenantId: string): Promise<TenantConfig | null> {
    return this.configs.get(tenantId) ?? null;
  }
  async saveConfig(c: TenantConfig): Promise<TenantConfig> {
    this.configs.set(c.tenantId, c);
    return c;
  }
  async listEvidence(tenantId: string): Promise<Evidence[]> {
    return this.evidence.get(tenantId) ?? [];
  }
  async saveEvidence(e: Evidence): Promise<Evidence> {
    const list = this.evidence.get(e.tenantId) ?? [];
    const idx = list.findIndex((x) => x.id === e.id);
    if (idx >= 0) list[idx] = e; // upsert by id so edits don't duplicate
    else list.push(e);
    this.evidence.set(e.tenantId, list);
    return e;
  }
  async deleteEvidence(tenantId: string, id: string): Promise<void> {
    const list = this.evidence.get(tenantId);
    if (list) this.evidence.set(tenantId, list.filter((e) => e.id !== id));
  }

  async saveMatches(matches: Match[]): Promise<void> {
    for (const m of matches) {
      const list = this.matches.get(m.tenantId) ?? [];
      const idx = list.findIndex((x) => x.postingId === m.postingId);
      if (idx >= 0) list[idx] = m;
      else list.push(m);
      this.matches.set(m.tenantId, list);
    }
  }

  async listMatches(tenantId: string, limit = 50): Promise<Array<Match & { posting: Posting }>> {
    const { archived } = await this.getPostingUserState(tenantId);
    const list = (this.matches.get(tenantId) ?? [])
      .filter((m) => m.rulePass)
      .sort((a, b) => b.score - a.score);
    return list
      .map((m) => {
        const posting = this.postings.get(m.postingId);
        // feed = active + non-invalidated + non-stale + not archived by this tenant
        if (!posting || !posting.isActive || posting.status !== "active" || archived.has(posting.id)) return null;
        return { ...m, posting };
      })
      .filter((x): x is Match & { posting: Posting } => x !== null)
      .slice(0, limit);
  }
  async listMatchesForPostings(tenantId: string, postingIds: string[]): Promise<Match[]> {
    const ids = new Set(postingIds);
    return (this.matches.get(tenantId) ?? []).filter((m) => ids.has(m.postingId));
  }

  async getStoreMeta(key: string): Promise<string | null> {
    return this.storeMeta.get(key) ?? null;
  }
  async setStoreMeta(key: string, value: string): Promise<void> {
    this.storeMeta.set(key, value);
  }

  async getSalaryCache(key: string): Promise<SalaryCacheEntry | null> {
    const e = this.salaryCache.get(key);
    if (!e) return null;
    const ageDays = (Date.now() - e.fetchedAt) / 86_400_000;
    if (ageDays > (e.ttlDays ?? 14)) {
      this.salaryCache.delete(key);
      return null;
    }
    return e;
  }
  async putSalaryCache(entry: SalaryCacheEntry): Promise<void> {
    this.salaryCache.set(entry.key, { ...entry, fetchedAt: Date.now() });
  }

  // ── generation cache ──
  async getGeneration(
    tenantId: string,
    postingId: string | null,
    kind: GenerationKind,
    prompt = "",
  ): Promise<Generation | null> {
    return (
      this.generations.find(
        (g) => g.tenantId === tenantId && g.postingId === postingId && g.kind === kind && g.prompt === prompt,
      ) ?? null
    );
  }
  async listGenerations(tenantId: string, postingId?: string | null): Promise<Generation[]> {
    return this.generations.filter(
      (g) => g.tenantId === tenantId && (postingId === undefined || g.postingId === postingId),
    );
  }
  async saveGeneration(g: Generation): Promise<Generation> {
    // replace-the-slot: one row per (tenant, posting, kind, prompt)
    this.generations = this.generations.filter(
      (x) => !(x.tenantId === g.tenantId && x.postingId === g.postingId && x.kind === g.kind && x.prompt === g.prompt),
    );
    this.generations.push(g);
    return g;
  }
  async clearGenerations(tenantId: string, opts?: { postingId?: string | null }): Promise<number> {
    const before = this.generations.length;
    this.generations = this.generations.filter((g) => {
      if (g.tenantId !== tenantId) return true;
      if (opts && opts.postingId !== undefined) return g.postingId !== opts.postingId;
      return false; // clear all for the tenant
    });
    return before - this.generations.length;
  }

  // ── connected context ──
  async listContexts(tenantId: string): Promise<ConnectedContext[]> {
    return [...this.contexts.values()].filter((c) => c.tenantId === tenantId);
  }
  async getContext(tenantId: string, source: ProfileSourceKind): Promise<ConnectedContext | null> {
    return this.contexts.get(`${tenantId}:${source}`) ?? null;
  }
  async upsertContext(c: ConnectedContext): Promise<ConnectedContext> {
    this.contexts.set(`${c.tenantId}:${c.source}`, c);
    return c;
  }
  async setContextEnabled(tenantId: string, source: ProfileSourceKind, enabled: boolean): Promise<void> {
    const c = this.contexts.get(`${tenantId}:${source}`);
    if (c) c.enabled = enabled;
  }
  async deleteContext(tenantId: string, source: ProfileSourceKind): Promise<void> {
    this.contexts.delete(`${tenantId}:${source}`);
  }

  async upsertApplication(a: Application): Promise<Application> {
    const list = this.applications.get(a.tenantId) ?? [];
    const idx = list.findIndex((x) => x.id === a.id || x.postingId === a.postingId);
    if (idx >= 0) list[idx] = a;
    else list.push(a);
    this.applications.set(a.tenantId, list);
    return a;
  }
  async listApplications(tenantId: string): Promise<Application[]> {
    return this.applications.get(tenantId) ?? [];
  }
  async listApplicationsWithPosting(tenantId: string): Promise<Array<Application & { posting: Posting | null }>> {
    return (this.applications.get(tenantId) ?? []).map((a) => ({ ...a, posting: this.postings.get(a.postingId) ?? null }));
  }
  async getApplicationByPosting(tenantId: string, postingId: string): Promise<Application | null> {
    return (this.applications.get(tenantId) ?? []).find((a) => a.postingId === postingId) ?? null;
  }
  async appliedDedupKeys(tenantId: string): Promise<Set<string>> {
    const apps = this.applications.get(tenantId) ?? [];
    const keys = new Set<string>();
    for (const a of apps) {
      const p = this.postings.get(a.postingId);
      if (p) keys.add(p.dedupKey);
    }
    return keys;
  }

  // ── jobs ──
  async enqueueJob(input: EnqueueJob): Promise<Job> {
    const job: Job = {
      id: randomUUID(),
      tenantId: input.tenantId,
      type: input.type,
      runtime: input.runtime,
      payload: input.payload ?? {},
      status: "queued",
      result: null,
      error: null,
      createdAt: new Date(),
      pickedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    return job;
  }
  async claimJob(runtime: JobRuntime, opts?: { tenantId?: string }): Promise<Job | null> {
    const job = this.jobs
      .filter((j) => j.runtime === runtime && j.status === "queued" && (!opts?.tenantId || j.tenantId === opts.tenantId))
      .sort((a, b) => +new Date(a.createdAt as Date) - +new Date(b.createdAt as Date))[0];
    if (!job) return null;
    job.status = "running";
    job.pickedAt = new Date();
    return job;
  }
  async completeJob(
    id: string,
    status: Extract<JobStatus, "done" | "error">,
    payload: { result?: Record<string, unknown>; error?: string },
  ): Promise<void> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    job.status = status;
    job.result = payload.result ?? null;
    job.error = payload.error ?? null;
    job.finishedAt = new Date();
  }
  async requeueStuckJobs(runtime: JobRuntime, olderThanMinutes: number): Promise<number> {
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    let n = 0;
    for (const j of this.jobs) {
      if (j.runtime === runtime && j.status === "running" && j.pickedAt && new Date(j.pickedAt as Date).getTime() < cutoff) {
        j.status = "queued";
        j.pickedAt = null;
        n++;
      }
    }
    return n;
  }
  async listJobs(tenantId: string, limit = 30): Promise<Job[]> {
    return this.jobs
      .filter((j) => j.tenantId === tenantId)
      .sort((a, b) => +new Date(b.createdAt as Date) - +new Date(a.createdAt as Date))
      .slice(0, limit);
  }

  // ── heartbeat ──
  async upsertHeartbeat(h: AgentHeartbeat): Promise<void> {
    this.heartbeats.set(h.tenantId, h);
  }
  async getHeartbeat(tenantId: string): Promise<AgentHeartbeat | null> {
    return this.heartbeats.get(tenantId) ?? null;
  }

  // ── tenants + accounts ──
  async createTenant(input: { name: string; id?: string }): Promise<Tenant> {
    const id = input.id ?? randomUUID();
    const existing = this.tenants.get(id);
    if (existing) return existing;
    const t: Tenant = { id, name: input.name, createdAt: new Date(), lastActiveAt: null };
    this.tenants.set(id, t);
    return t;
  }
  async getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }
  async listTenants(opts?: { activeSinceDays?: number }): Promise<Tenant[]> {
    const all = [...this.tenants.values()];
    if (opts?.activeSinceDays == null) return all;
    const cutoff = Date.now() - opts.activeSinceDays * 86_400_000;
    // a tenant never marked active (single-user / CLI) still counts — it is the operator
    return all.filter((t) => t.lastActiveAt == null || new Date(t.lastActiveAt as Date).getTime() >= cutoff);
  }
  async touchTenantActive(id: string): Promise<void> {
    const t = this.tenants.get(id);
    if (t) t.lastActiveAt = new Date();
  }
  async createUser(input: { tenantId: string; email: string; passwordHash: string | null; role: UserRole }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    if ([...this.users.values()].some((u) => u.email === email)) throw new Error("email already registered");
    const u = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email,
      role: input.role,
      externalId: null,
      createdAt: new Date(),
      disabledAt: null,
      passwordHash: input.passwordHash,
    };
    this.users.set(u.id, u);
    return stripHash(u);
  }
  async countUsers(): Promise<number> {
    return this.users.size;
  }
  async findUserByEmail(email: string): Promise<(User & { passwordHash: string | null }) | null> {
    const e = email.trim().toLowerCase();
    const u = [...this.users.values()].find((x) => x.email === e);
    return u ? { ...u } : null;
  }
  async getUser(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? stripHash(u) : null;
  }
  async setUserPassword(id: string, passwordHash: string): Promise<void> {
    const u = this.users.get(id);
    if (u) u.passwordHash = passwordHash;
  }

  // ── sessions + tokens ──
  async createSession(s: Session & { secretHash: string }): Promise<void> {
    this.sessions.set(s.id, { ...s });
  }
  async getSession(id: string): Promise<(Session & { secretHash: string }) | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async touchSession(id: string, expiresAt: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      s.lastSeenAt = new Date();
      s.expiresAt = expiresAt;
    }
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
  async deleteUserSessions(userId: string, exceptId?: string): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId && id !== exceptId) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }
  async createApiToken(t: ApiToken & { secretHash: string }): Promise<void> {
    this.tokens.set(t.id, { ...t });
  }
  async getApiToken(id: string): Promise<(ApiToken & { secretHash: string }) | null> {
    const t = this.tokens.get(id);
    return t ? { ...t } : null;
  }
  async listApiTokens(tenantId: string): Promise<ApiToken[]> {
    return [...this.tokens.values()]
      .filter((t) => t.tenantId === tenantId)
      .map(({ secretHash: _s, ...rest }) => rest);
  }
  async revokeApiToken(tenantId: string, id: string): Promise<boolean> {
    const t = this.tokens.get(id);
    if (!t || t.tenantId !== tenantId || t.revokedAt) return false;
    t.revokedAt = new Date();
    return true;
  }
  async touchApiToken(id: string): Promise<void> {
    const t = this.tokens.get(id);
    if (t) t.lastUsedAt = new Date();
  }

  // ── saved searches ──
  async listSavedSearches(tenantId: string): Promise<SavedSearch[]> {
    return [...this.savedSearches.values()]
      .filter((s) => s.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async getSavedSearch(tenantId: string, id: string): Promise<SavedSearch | null> {
    const s = this.savedSearches.get(id);
    return s && s.tenantId === tenantId ? s : null;
  }
  async saveSavedSearch(s: SavedSearch): Promise<SavedSearch> {
    const clash = [...this.savedSearches.values()].find(
      (x) => x.tenantId === s.tenantId && x.id !== s.id && x.name.toLowerCase() === s.name.toLowerCase(),
    );
    if (clash) throw new Error(`a saved search named "${s.name}" already exists`);
    const existing = this.savedSearches.get(s.id);
    if (existing && existing.tenantId !== s.tenantId) throw new Error("saved search belongs to another tenant");
    this.savedSearches.set(s.id, { ...s });
    return s;
  }
  async deleteSavedSearch(tenantId: string, id: string): Promise<void> {
    const s = this.savedSearches.get(id);
    if (s && s.tenantId === tenantId) this.savedSearches.delete(id);
  }
  async recordSavedSearchRun(tenantId: string, id: string, result: Record<string, unknown>): Promise<void> {
    const s = this.savedSearches.get(id);
    if (s && s.tenantId === tenantId) {
      s.lastRunAt = new Date();
      s.lastResult = result;
    }
  }
  async listAllSourceSearches(): Promise<SavedSearch[]> {
    return [...this.savedSearches.values()].filter((s) => s.enabled && s.asSource);
  }

  // ── discovery sources ──
  async listDiscoverySources(tenantId: string): Promise<DiscoverySource[]> {
    return [...this.discoverySources.values()].filter((s) => s.tenantId === tenantId);
  }
  async saveDiscoverySource(s: DiscoverySource): Promise<DiscoverySource> {
    const dupe = [...this.discoverySources.values()].find(
      (x) => x.tenantId === s.tenantId && x.configKey === s.configKey && x.id !== s.id,
    );
    if (dupe) return dupe;
    const existing = this.discoverySources.get(s.id);
    if (existing && existing.tenantId !== s.tenantId) throw new Error("source belongs to another tenant");
    this.discoverySources.set(s.id, { ...s });
    return s;
  }
  async deleteDiscoverySource(tenantId: string, id: string): Promise<void> {
    const s = this.discoverySources.get(id);
    if (s && s.tenantId === tenantId) this.discoverySources.delete(id);
  }
  async recordDiscoverySourceRun(
    id: string,
    run: { status: "ok" | "empty" | "error"; count: number; error?: string | null },
  ): Promise<void> {
    const s = this.discoverySources.get(id);
    if (!s) return;
    s.lastRunAt = new Date();
    s.lastStatus = run.status;
    s.lastCount = run.count;
    s.lastError = run.error ?? null;
  }
  async listAllEnabledDiscoverySources(): Promise<DiscoverySource[]> {
    return [...this.discoverySources.values()].filter((s) => s.enabled);
  }

  // ── follows ──
  async followCompany(tenantId: string, companyId: string): Promise<void> {
    const set = this.follows.get(tenantId) ?? new Set<string>();
    set.add(companyId);
    this.follows.set(tenantId, set);
  }
  async unfollowCompany(tenantId: string, companyId: string): Promise<void> {
    this.follows.get(tenantId)?.delete(companyId);
  }
  async listFollowedCompanyIds(tenantId: string): Promise<string[]> {
    return [...(this.follows.get(tenantId) ?? [])];
  }
}

function stripHash(u: User & { passwordHash: string | null }): User {
  const { passwordHash: _h, ...rest } = u;
  return rest;
}

function isDue(c: Company): boolean {
  if (c.status !== "active") return false;
  if (!c.lastPolled) return true;
  const last = new Date(c.lastPolled as string | Date).getTime();
  const ageH = (Date.now() - last) / 3_600_000;
  return c.pollCadence === "daily" ? ageH >= 20 : c.pollCadence === "weekly" ? ageH >= 24 * 6 : false;
}

type DateLike = string | Date | null | undefined;
const ms = (d: DateLike) => (d == null || d === "" ? NaN : new Date(d).getTime());

/** the earlier of two publish dates (either may be missing) — Postgres `least()` semantics */
function earlierDate(a: DateLike, b: DateLike): Posting["postedAt"] {
  const [ta, tb] = [ms(a), ms(b)];
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? (b as Posting["postedAt"]) : null;
  if (!Number.isFinite(tb)) return a as Posting["postedAt"];
  return ta <= tb ? (a as Posting["postedAt"]) : (b as Posting["postedAt"]);
}

/**
 * The source re-stamped a posting we already hold (§3): its new date is after our last
 * sighting (so it changed since the previous poll — counted once) and well after we
 * first saw the job (not the jitter of a relative "Posted 30+ days ago").
 */
function isRedated(existing: Posting, newPostedAt: DateLike): boolean {
  const t = ms(newPostedAt);
  return Number.isFinite(t) && t > ms(existing.lastSeen) && t > ms(existing.firstSeen) + 2 * 86_400_000;
}
