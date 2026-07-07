import { randomUUID } from "node:crypto";
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
  Match,
  Posting,
  Profile,
  SalaryBand,
  TenantConfig,
} from "@jobflow/core";
import type {
  CompanyEnrichmentPatch,
  EnqueueJob,
  NewPosting,
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
  private generations: Generation[] = [];
  private contexts = new Map<string, ConnectedContext>(); // key: `${tenantId}:${source}`

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
      if (p.isActive) counts[p.companyId] = (counts[p.companyId] ?? 0) + 1;
    }
    return counts;
  }

  async upsertPosting(p: NewPosting): Promise<Posting> {
    const key = `${p.atsType}:${p.atsJobId}`;
    const existingId = this.postingByAtsKey.get(key);
    const now = new Date();
    if (existingId) {
      const existing = this.postings.get(existingId)!;
      const reposted = existing.titleNorm !== p.titleNorm; // title changed → likely a repost
      const updated: Posting = {
        ...existing,
        ...p,
        id: existing.id,
        firstSeen: existing.firstSeen,
        lastSeen: now,
        isActive: true,
        repostCount: existing.repostCount + (reposted ? 1 : 0),
        canonicalId: existing.canonicalId,
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
    };
    this.postings.set(posting.id, posting);
    this.postingByAtsKey.set(key, posting.id);
    return posting;
  }

  async getPosting(id: string): Promise<Posting | null> {
    return this.postings.get(id) ?? null;
  }

  async listActivePostings(): Promise<Posting[]> {
    return [...this.postings.values()].filter((p) => p.isActive);
  }
  async listPostingsByCompany(companyId: string): Promise<Posting[]> {
    return [...this.postings.values()].filter((p) => p.companyId === companyId && p.isActive);
  }

  async setCanonical(postingId: string, canonicalId: string): Promise<void> {
    const p = this.postings.get(postingId);
    if (p) p.canonicalId = canonicalId;
  }
  async updatePostingSalary(id: string, band: SalaryBand): Promise<void> {
    const p = this.postings.get(id);
    if (p) p.salary = band;
  }

  async markStale(companyId: string, seenAtsJobIds: string[]): Promise<number> {
    const seen = new Set(seenAtsJobIds);
    let n = 0;
    for (const p of this.postings.values()) {
      if (p.companyId === companyId && p.isActive && !seen.has(p.atsJobId)) {
        p.isActive = false;
        n++;
      }
    }
    return n;
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
    const list = (this.matches.get(tenantId) ?? [])
      .filter((m) => m.rulePass)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return list
      .map((m) => {
        const posting = this.postings.get(m.postingId);
        return posting ? { ...m, posting } : null;
      })
      .filter((x): x is Match & { posting: Posting } => x !== null);
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
  async claimJob(runtime: JobRuntime): Promise<Job | null> {
    const job = this.jobs
      .filter((j) => j.runtime === runtime && j.status === "queued")
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
}

function isDue(c: Company): boolean {
  if (c.status !== "active") return false;
  if (!c.lastPolled) return true;
  const last = new Date(c.lastPolled as string | Date).getTime();
  const ageH = (Date.now() - last) / 3_600_000;
  return c.pollCadence === "daily" ? ageH >= 20 : c.pollCadence === "weekly" ? ageH >= 24 * 6 : false;
}
