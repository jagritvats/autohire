import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  normCompany,
  normalizePosting,
  scorePosting,
  scopedJobId,
  type AtsType,
  type Match,
  type Posting,
  type Profile,
  type RawPosting,
  type SourceKind,
} from "@jobflow/core";
import { DEFAULT_TENANT, defaultProfile, toNewPosting } from "@jobflow/pipeline";
import type { Repository } from "@jobflow/db";
import { corpusEmbedder } from "./embedder.js";
import { ensureTenant, getRepo } from "./repo.js";

/**
 * The browser extension's two endpoints (§7.1 layer 1). The extension reads a posting
 * you're ALREADY viewing and sends its text — no crawling, and no session ever reaches
 * the server (invariant #1): the server only sees the page text you chose to send.
 *   score   — how it matches your profile (the stored match if it's in the feed)
 *   capture — save it: a known board also gets registered, so polls keep it fresh
 */

export interface PageCapture {
  url: string;
  title: string;
  jdText: string;
  /** best-effort from the page (the extension reads og:site_name / company selectors) */
  company?: string;
  location?: string;
}

export interface ScoreResult {
  score: number;
  rulePass: boolean;
  stackNote: string | null;
  levelNote: string | null;
  redFlags: string[];
  /** already in your feed — the score is the stored match, not a fresh estimate */
  inFeed: boolean;
  postingId: string | null;
}

/**
 * No login exists yet, so these endpoints must not be callable from arbitrary sites (any
 * page could otherwise POST to localhost). Browsers always send Origin on cross-origin
 * POSTs: allow only the extension (its service worker makes the calls) and the app itself.
 */
export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser cross-origin request (curl, server-to-server)
  if (origin.startsWith("chrome-extension://")) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

const TIER3_SOURCES = new Set<SourceKind>(["linkedin", "naukri"]);

/** Which board/job a page URL is — so a known posting resolves to its stored row. */
export function identifyPage(url: string): { source: SourceKind; atsType: AtsType; slug: string | null; jobId: string } {
  const m =
    url.match(/(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i) ??
    url.match(/()[?&]gh_jid=(\d+)/i);
  if (m) return { source: "greenhouse", atsType: m[1] ? "greenhouse" : "unknown", slug: m[1] || null, jobId: m[2]! };
  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (lever) return { source: "lever", atsType: "lever", slug: lever[1]!, jobId: lever[2]! };
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (ashby) return { source: "ashby", atsType: "ashby", slug: ashby[1]!, jobId: ashby[2]! };
  const li = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d+)/i) ?? url.match(/linkedin\.com\/jobs\/.*[?&]currentJobId=(\d+)/i);
  if (li) return { source: "linkedin", atsType: "unknown", slug: null, jobId: li[1]! };
  const naukri = url.match(/naukri\.com\/job-listings-[^?#]*?-(\d{9,})/i);
  if (naukri) return { source: "naukri", atsType: "unknown", slug: null, jobId: naukri[1]! };
  const bare = url.split(/[?#]/)[0]!;
  return { source: "capture", atsType: "unknown", slug: null, jobId: createHash("sha1").update(bare).digest("hex").slice(0, 16) };
}

function toRaw(page: PageCapture): RawPosting {
  const id = identifyPage(page.url);
  let host = "";
  try {
    host = new URL(page.url).hostname.replace(/^www\./, "");
  } catch {
    /* keep empty */
  }
  const company =
    page.company?.trim() ||
    (id.slug ? id.slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "") ||
    host.split(".")[0] ||
    "Unknown";
  return {
    source: id.source,
    tier: TIER3_SOURCES.has(id.source) ? "tier3" : "tier1",
    atsType: id.atsType,
    atsJobId: id.jobId,
    companyName: company,
    companySlug: id.slug,
    title: page.title.trim().slice(0, 200),
    jdText: page.jdText.slice(0, 20_000),
    jdHtml: null,
    locationRaw: page.location?.trim() || null,
    applyUrl: page.url,
    salaryRaw: null,
    postedAt: null,
    fetchedAt: new Date(),
    raw: {},
  };
}

async function tenantProfile(repo: Repository): Promise<Profile> {
  await ensureTenant(repo);
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  if (profile.profileEmbedding) return profile;
  const text = `${profile.prefs.stackProfile.join(" ")} ${profile.prefs.targetArchetypes.join(" ")} ${profile.masterResume}`;
  return { ...profile, profileEmbedding: await corpusEmbedder()(text) };
}

async function storedFor(repo: Repository, raw: RawPosting): Promise<Posting | null> {
  const [p] = await repo.findPostingsByAtsIds(raw.atsType, [scopedJobId(raw)]);
  return p ?? null;
}

function fromMatch(m: Pick<Match, "score" | "rulePass" | "stackNote" | "levelNote" | "redFlags">, postingId: string | null, inFeed: boolean): ScoreResult {
  return { score: m.score, rulePass: m.rulePass, stackNote: m.stackNote, levelNote: m.levelNote, redFlags: m.redFlags.slice(0, 4), inFeed, postingId };
}

export async function scorePage(page: PageCapture): Promise<ScoreResult> {
  const repo = await getRepo();
  const raw = toRaw(page);
  const profile = await tenantProfile(repo);

  const stored = await storedFor(repo, raw);
  if (stored) {
    const [m] = await repo.listMatchesForPostings(DEFAULT_TENANT, [stored.id]);
    if (m) return fromMatch(m, stored.id, stored.isActive && stored.status === "active");
  }
  // not in the corpus: score the page as a transient posting (nothing is stored)
  const np = await toNewPosting(normalizePosting(raw), randomUUID(), raw.companyName, corpusEmbedder());
  const now = new Date();
  const posting: Posting = {
    ...np,
    id: randomUUID(),
    firstSeen: now,
    lastSeen: now,
    isActive: true,
    repostCount: 0,
    status: "active",
    invalidReason: null,
    invalidatedAt: null,
    canonicalId: null,
  };
  const s = scorePosting(posting, profile);
  return fromMatch(
    {
      score: s.score,
      rulePass: s.rulePass,
      stackNote: s.flags.stack.note,
      levelNote: s.flags.levelNote,
      redFlags: s.flags.hardExclusionReason ? [s.flags.hardExclusionReason, ...s.flags.redFlags] : s.flags.redFlags,
    },
    null,
    false,
  );
}

export interface CaptureResult extends ScoreResult {
  /** the page was on a known ATS board — the company is registered and will be polled */
  boardRegistered: boolean;
}

/**
 * Save a captured posting: stored like any other posting, bookmarked for you, and scored
 * into the feed straight away. A Greenhouse/Lever/Ashby page also registers its board,
 * so the next poll keeps the posting (and its siblings) fresh from the source.
 */
export async function capturePage(page: PageCapture): Promise<CaptureResult> {
  const repo = await getRepo();
  const raw = toRaw(page);
  const profile = await tenantProfile(repo);
  const normalized = normalizePosting(raw);
  const company = await repo.upsertCompany({
    name: normalized.companyName,
    nameNorm: normCompany(normalized.companyName),
    atsType: raw.atsType,
    atsSlug: raw.companySlug,
    tags: ["captured"],
  });
  const prior = await storedFor(repo, raw);
  const posting = await repo.upsertPosting(await toNewPosting(normalized, company.id, company.name, corpusEmbedder(), prior ?? undefined));
  await repo.setPostingBookmarked(DEFAULT_TENANT, posting.id, true);

  const s = scorePosting(posting, profile);
  const match: Match = {
    id: randomUUID(),
    tenantId: DEFAULT_TENANT,
    postingId: posting.id,
    score: s.score,
    scoreBreakdown: s.breakdown,
    rulePass: s.rulePass,
    whyFit: s.flags.stack.note,
    gap: null,
    stackNote: s.flags.stack.note,
    levelNote: s.flags.levelNote,
    redFlags: s.flags.hardExclusionReason ? [...s.flags.redFlags, s.flags.hardExclusionReason] : s.flags.redFlags,
    generatedAt: new Date(),
  };
  await repo.saveMatches([match]);
  return { ...fromMatch(match, posting.id, true), boardRegistered: raw.atsType !== "unknown" };
}
