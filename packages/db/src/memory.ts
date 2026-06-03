import { randomUUID } from "node:crypto";
import type {
  Application,
  Company,
  Evidence,
  Match,
  Posting,
  Profile,
} from "@jobflow/core";
import type { NewPosting, Repository, UpsertCompany } from "./repository.js";

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
  private evidence = new Map<string, Evidence[]>();
  private matches = new Map<string, Match[]>();
  private applications = new Map<string, Application[]>();

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
      createdAt: new Date(),
    };
    this.companies.set(company.id, company);
    this.companyByNorm.set(c.nameNorm, company.id);
    return company;
  }

  async findCompanyByNameNorm(nameNorm: string): Promise<Company | null> {
    const id = this.companyByNorm.get(nameNorm);
    return id ? (this.companies.get(id) ?? null) : null;
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

  async setCanonical(postingId: string, canonicalId: string): Promise<void> {
    const p = this.postings.get(postingId);
    if (p) p.canonicalId = canonicalId;
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
  async listEvidence(tenantId: string): Promise<Evidence[]> {
    return this.evidence.get(tenantId) ?? [];
  }
  async saveEvidence(e: Evidence): Promise<Evidence> {
    const list = this.evidence.get(e.tenantId) ?? [];
    list.push(e);
    this.evidence.set(e.tenantId, list);
    return e;
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

  async upsertApplication(a: Application): Promise<Application> {
    const list = this.applications.get(a.tenantId) ?? [];
    const idx = list.findIndex((x) => x.id === a.id);
    if (idx >= 0) list[idx] = a;
    else list.push(a);
    this.applications.set(a.tenantId, list);
    return a;
  }
  async listApplications(tenantId: string): Promise<Application[]> {
    return this.applications.get(tenantId) ?? [];
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
}

function isDue(c: Company): boolean {
  if (c.status !== "active") return false;
  if (!c.lastPolled) return true;
  const last = new Date(c.lastPolled as string | Date).getTime();
  const ageH = (Date.now() - last) / 3_600_000;
  return c.pollCadence === "daily" ? ageH >= 20 : c.pollCadence === "weekly" ? ageH >= 24 * 6 : false;
}
