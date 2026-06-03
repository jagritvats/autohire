import "server-only";
import { InMemoryRepository, type Repository } from "@jobflow/db";
import {
  DEFAULT_TENANT,
  SEED_COMPANIES,
  defaultProfile,
  seedEvidence,
  discoverCompanies,
  ingestCompany,
  ingestFromAdapter,
  rebuildMatches,
} from "@jobflow/pipeline";
import { getAdapter } from "@jobflow/adapters";

/** Serializable match-card DTO for the client UI (§11.6). */
export interface FeedCard {
  id: string;
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
}

export interface FeedData {
  cards: FeedCard[];
  stats: { companies: number; postings: number; ranked: number; excluded: number; generatedAt: string };
}

// ── module-level memo (single-user app); refresh via the API route ──
let cache: { data: FeedData; at: number } | null = null;
const TTL_MS = 30 * 60_000;

export async function getFeed(force = false): Promise<FeedData> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = await buildFeed();
  cache = { data, at: Date.now() };
  return data;
}

async function buildFeed(): Promise<FeedData> {
  const repo: Repository = new InMemoryRepository();
  const profile = defaultProfile();
  await repo.saveProfile(profile);
  for (const e of seedEvidence()) await repo.saveEvidence(e);

  await discoverCompanies(repo, SEED_COMPANIES);

  const companies = await repo.listCompanies({ status: "active" });
  for (const c of companies) {
    if (c.atsType === "unknown" || !c.atsSlug) continue;
    await ingestCompany(repo, c, { limit: 50 });
  }
  await ingestFromAdapter(repo, getAdapter("hn_whoishiring")!, { query: "backend", limit: 40 });
  await ingestFromAdapter(repo, getAdapter("remotive")!, { query: "backend", limit: 40 });

  const result = await rebuildMatches(repo, profile);
  const matches = await repo.listMatches(DEFAULT_TENANT, 80);

  const cards: FeedCard[] = matches.map((m) => {
    const p = m.posting;
    const ageDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(p.firstSeen as string).getTime()) / 86_400_000),
    );
    return {
      id: p.id,
      title: p.title,
      company: p.companyName,
      score: m.score,
      archetype: p.roleArchetype,
      source: p.source,
      tier: p.tier,
      ats: p.atsType,
      ageDays,
      atsDirect: p.atsType !== "unknown",
      location: {
        mode: p.location.mode,
        label: [p.location.city, p.location.country].filter(Boolean).join(", "),
        remoteGeo: p.location.remoteGeo,
      },
      level: p.levelBand,
      levelNote: m.levelNote,
      stackNote: m.stackNote,
      skills: p.jdSkills.slice(0, 10),
      comp: compLabel(p),
      rating: null, // ratings come from Tier-3 enrichment (local agent), not the cloud feed
      redFlags: m.redFlags,
      applyUrl: p.applyUrl,
    };
  });

  return {
    cards,
    stats: {
      companies: (await repo.listCompanies()).length,
      postings: (await repo.listActivePostings()).length,
      ranked: result.ranked,
      excluded: result.excluded,
      generatedAt: new Date().toISOString(),
    },
  };
}

function compLabel(p: { salary: { min: number | null; max: number | null; currency: string; confidence: string; source: string } }) {
  const s = p.salary;
  if (s.min == null && s.max == null) return null;
  const f = (n: number) =>
    s.currency === "INR" ? `₹${(n / 100000).toFixed(0)}L` : s.currency === "USD" ? `$${Math.round(n / 1000)}k` : `${Math.round(n / 1000)}k`;
  const label = s.min != null && s.max != null ? `${f(s.min)}–${f(s.max)}` : `${f((s.min ?? s.max)!)}+`;
  return { label, confidence: s.confidence, source: s.source };
}
