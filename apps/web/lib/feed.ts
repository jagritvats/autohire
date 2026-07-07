import "server-only";
import type { Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
} from "@jobflow/pipeline";
import { getAdapter } from "@jobflow/adapters";
import type { Posting } from "@jobflow/core";
import { getRepo, ensureTenant } from "./repo.js";

/** Serializable match-card DTO for the client UI (§11.6). */
export interface FeedCard {
  id: string;
  companyId: string;
  title: string;
  company: string;
  score: number;
  archetype: string;
  source: string;
  tier: string;
  ats: string;
  ageDays: number;
  atsDirect: boolean;
  location: { mode: string; label: string; remoteGeo: string };
  level: string | null;
  levelNote: string | null;
  stackNote: string | null;
  skills: string[];
  comp: { label: string; confidence: string; source: string } | null;
  rating: { overall: number; reviews: number } | null;
  redFlags: string[];
  applyUrl: string | null;
  /** don't-double-apply: true if this company+role is already in the CRM (§7). */
  applied: boolean;
}

export interface FeedData {
  cards: FeedCard[];
  stats: { companies: number; postings: number; ranked: number; excluded: number; durable: boolean; generatedAt: string };
}

/** Read the feed from the repo. Bootstraps + ingests once if the store is empty. */
export async function getFeed(): Promise<FeedData> {
  const repo = await getRepo();
  await ensureTenant(repo);
  let matches = await repo.listMatches(DEFAULT_TENANT, 80);
  if (matches.length === 0) {
    await ingestAndRank(repo);
    matches = await repo.listMatches(DEFAULT_TENANT, 80);
  }
  return shape(repo, matches);
}

/** Force a fresh poll of the live Tier 1-2 sources + re-rank, then return the feed. */
export async function refreshFeed(): Promise<FeedData> {
  const repo = await getRepo();
  await ensureTenant(repo);
  await ingestAndRank(repo);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return shape(repo, matches);
}

/** Re-rank only (after a settings change) — no re-poll. */
export async function rerankOnly(): Promise<FeedData> {
  const repo = await getRepo();
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  await rebuildMatches(repo, profile);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);
  return shape(repo, matches);
}

async function ingestAndRank(repo: Repository): Promise<void> {
  await discoverCompanies(repo, SEED_COMPANIES);
  const companies = await repo.listCompanies({ status: "active" });
  for (const c of companies) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    await ingestCompany(repo, c, { limit: 50 });
  }
  await ingestFromAdapter(repo, getAdapter("hn_whoishiring")!, { query: "backend", limit: 40 });
  await ingestFromAdapter(repo, getAdapter("remotive")!, { query: "backend", limit: 40 });
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  await rebuildMatches(repo, profile);
}

async function shape(repo: Repository, matches: Awaited<ReturnType<Repository["listMatches"]>>): Promise<FeedData> {
  const appliedKeys = await repo.appliedDedupKeys(DEFAULT_TENANT);
  const cards: FeedCard[] = matches.map((m) => {
    const p = m.posting;
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(p.firstSeen as string).getTime()) / 86_400_000));
    return {
      id: p.id,
      companyId: p.companyId,
      title: p.title,
      company: p.companyName,
      score: m.score,
      archetype: p.roleArchetype,
      source: p.source,
      tier: p.tier,
      ats: p.atsType,
      ageDays,
      atsDirect: p.atsType !== "unknown",
      location: { mode: p.location.mode, label: [p.location.city, p.location.country].filter(Boolean).join(", "), remoteGeo: p.location.remoteGeo },
      level: p.levelBand,
      levelNote: m.levelNote,
      stackNote: m.stackNote,
      skills: p.jdSkills.slice(0, 10),
      comp: compLabel(p),
      rating: ratingOf(m.posting),
      redFlags: m.redFlags,
      applyUrl: p.applyUrl,
      applied: appliedKeys.has(p.dedupKey),
    };
  });
  const allActive = await repo.listActivePostings();
  return {
    cards,
    stats: {
      companies: (await repo.listCompanies()).length,
      postings: allActive.length,
      ranked: cards.length,
      excluded: 0,
      durable: !!process.env.DATABASE_URL,
      generatedAt: new Date().toISOString(),
    },
  };
}

function compLabel(p: Posting) {
  const s = p.salary;
  if (s.min == null && s.max == null) return null;
  const f = (n: number) =>
    s.currency === "INR" ? `₹${(n / 100000).toFixed(0)}L` : s.currency === "USD" ? `$${Math.round(n / 1000)}k` : `${Math.round(n / 1000)}k`;
  const label = s.min != null && s.max != null ? `${f(s.min)}–${f(s.max)}` : `${f((s.min ?? s.max)!)}+`;
  return { label, confidence: s.confidence, source: s.source };
}

function ratingOf(p: Posting): { overall: number; reviews: number } | null {
  // ratings come from Tier-3 enrichment (local agent), surfaced via company.* later.
  return null;
}
