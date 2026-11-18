import { classifyLink, extractLinks, normalizeChatText, normCompany, type AtsType, type ChannelMessage, type Company, type LinkKind } from "@jobflow/core";
import { detectFromCareersPage, detectFromUrl } from "@jobflow/adapters";
import type { Repository } from "@jobflow/db";

/**
 * Community-channel harvesting (Telegram / WhatsApp export / pasted lists). The message
 * is never ingested as a posting — channels repost stale roles, drop dates, and carry
 * scams. Instead each ATS or careers link becomes DISCOVERY: resolve the company's
 * board, register it, and the normal poll fetches the real, fresh postings (and
 * markStale retires them when they close). Trust comes from the board, not the channel.
 */

export interface HarvestOptions {
  /** provenance tag, e.g. "telegram:somechannel" or "whatsapp:export". */
  origin: string;
  /** ignore messages older than this (stale forwards). */
  maxAgeDays?: number;
  /** cap on careers pages to sniff for an ATS this run (one fetch each). */
  maxCareersPages?: number;
}

export interface HarvestStats {
  messages: number;
  skippedOld: number;
  skippedSuspicious: number;
  links: Partial<Record<LinkKind, number>>;
  /** companies registered/updated with a resolved board, "name → ats/slug". */
  boards: string[];
}

/**
 * Deterministic scam signals from Indian job-fraud patterns (Naukri / TCS fraud
 * advisories): asking the candidate for money, task scams, and no-process "offers".
 * A message tripping these is skipped whole — its links are exactly the ones not to
 * follow. Paid-course PROMO ("limited seats", masterclass footers) is noise, not a
 * scam: it's on most posts in some good channels, so its links are dropped by the link
 * classifier instead of discarding the real job link in the same post.
 */
const MONEY_ASK = /\b(?:registration|security|refundable|processing|training|verification|laptop|kit|joining|onboarding|placement)\s*(?:fee|deposit|charges?|amount)s?|\bpay\s*(?:₹|rs\.?|inr)\s*\d|\bpay after placement/gi;
const TASK_SCAM = /\b(earn\s*(₹|rs\.?|inr)?\s*\d[\d,]*\s*(\/|per|a)\s*(day|hour|task)|daily (payout|payment|income)|task[- ]based (job|work)|prepaid task|merchant task|(like|subscribe)\b.{0,20}\b(youtube|videos?)|rate (hotels|products)|google reviews?|vip group|usdt|typing job|data entry job)\b/i;
const NO_PROCESS = /\b(no interview(?![- ]?prep)|without (an )?interview|direct joining|on[- ]the[- ]spot offer|100% (job|placement) guarantee|guaranteed (job|placement)|job guarantee|backdoor (entry|job|hiring))\b/i;
/** "Application fee: Nil", "No registration fee", "zero processing charges" — benign. */
const WAIVED_AFTER = /^\s*[:\-–]?\s*(nil|none|no\b|zero|free|not (required|applicable)|n\/a|₹?\s*0\b)/i;
const NEGATED_BEFORE = /\b(no|not|never|without|zero|don'?t|doesn'?t|do not|free of)\b[^.\n]{0,20}$/i;

export function isSuspiciousMessage(raw: string): boolean {
  const text = normalizeChatText(raw);
  if (TASK_SCAM.test(text) || NO_PROCESS.test(text)) return true;
  for (const m of text.matchAll(MONEY_ASK)) {
    const at = m.index ?? 0;
    if (WAIVED_AFTER.test(text.slice(at + m[0].length, at + m[0].length + 20))) continue;
    if (NEGATED_BEFORE.test(text.slice(Math.max(0, at - 30), at))) continue;
    return true;
  }
  return false;
}

export async function harvestLinks(
  repo: Repository,
  messages: ChannelMessage[],
  opts: HarvestOptions,
): Promise<HarvestStats> {
  const maxAgeMs = (opts.maxAgeDays ?? 30) * 86_400_000;
  const stats: HarvestStats = { messages: messages.length, skippedOld: 0, skippedSuspicious: 0, links: {}, boards: [] };
  const atsUrls = new Map<string, string>(); // host+first path segment → url (one probe per board)
  const careersUrls = new Map<string, string>(); // host → url

  for (const msg of messages) {
    if (msg.postedAt && Date.now() - msg.postedAt.getTime() > maxAgeMs) {
      stats.skippedOld++;
      continue;
    }
    if (isSuspiciousMessage(msg.text)) {
      stats.skippedSuspicious++;
      continue;
    }
    for (const url of extractLinks(normalizeChatText(msg.text))) {
      const link = classifyLink(url);
      stats.links[link.kind] = (stats.links[link.kind] ?? 0) + 1;
      if (link.kind === "ats") {
        const firstSeg = new URL(url).pathname.split("/")[1] ?? "";
        atsUrls.set(`${link.host}/${firstSeg}`, url);
      } else if (link.kind === "careers") {
        careersUrls.set(link.host, url);
      }
    }
  }

  const tags = ["community", opts.origin];
  // boards already registered (any name) — a link to one is a re-sighting, not a new company
  const known = new Map<string, Company>();
  for (const c of await repo.listCompanies()) if (c.atsSlug && c.atsType !== "unknown") known.set(boardKey(c.atsType, c.atsSlug), c);
  for (const url of atsUrls.values()) {
    const det = await detectFromUrl(url).catch(() => null);
    if (!det?.atsSlug || det.atsType === "unknown" || det.confidence !== "confirmed") continue;
    await register(repo, known, companyFromBoard(det.atsType, det.atsSlug), det.atsType, det.atsSlug, url, tags, stats);
  }
  let sniffed = 0;
  for (const [host, url] of careersUrls) {
    if (sniffed++ >= (opts.maxCareersPages ?? 10)) break;
    const det = await detectFromCareersPage(url).catch(() => null);
    if (!det?.atsSlug || det.atsType === "unknown") continue;
    await register(repo, known, companyFromHost(host), det.atsType, det.atsSlug, url, tags, stats);
  }
  return stats;
}

function boardKey(atsType: string, atsSlug: string): string {
  return `${atsType}|${atsSlug.toLowerCase()}`;
}

/**
 * Register a harvested board. A board we already hold keeps its company (and name): the
 * name guessed from a slug ("Thomsonreuters", "Gevernova") would otherwise register the same
 * board a second time under a second company — fetched twice, listed under two names (audit
 * 2026-11: 2 such pairs from one week of channels).
 */
async function register(
  repo: Repository,
  known: Map<string, Company>,
  name: string,
  atsType: AtsType,
  atsSlug: string,
  careersUrl: string,
  tags: string[],
  stats: HarvestStats,
): Promise<void> {
  const existing = known.get(boardKey(atsType, atsSlug));
  if (existing) {
    const add = tags.filter((t) => !existing.tags.includes(t));
    if (add.length) await repo.updateCompany(existing.id, { tags: [...existing.tags, ...add] });
    existing.tags = [...existing.tags, ...add];
    stats.boards.push(`${existing.name} → ${atsType}/${atsSlug}`);
    return;
  }
  const pretty = name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const company = await repo.upsertCompany({ name: pretty, nameNorm: normCompany(pretty), atsType, atsSlug, careersUrl, tags });
  known.set(boardKey(atsType, atsSlug), company);
  stats.boards.push(`${pretty} → ${atsType}/${atsSlug}`);
}

/** Multi-part board slugs carry the company in one segment: Workday "{host}/{tenant}/{site}",
 *  Eightfold "{host}/{domain}", Oracle "{tenant}.fa.{dc}.oraclecloud.com/{site}" (the tenant
 *  code is the only name the URL has — better than the whole host as a company name). */
function companyFromBoard(ats: string, slug: string): string {
  const parts = slug.split("/");
  if (ats === "workday") return parts[1] ?? slug;
  if (ats === "eightfold") return (parts[1] ?? slug).split(".")[0] ?? slug;
  if (ats === "oracle") return (parts[0] ?? slug).split(".")[0] ?? slug;
  return slug;
}

/** "careers.cred.club" → "cred"; "www.zerodha.com" → "zerodha". */
function companyFromHost(host: string): string {
  const parts = host.replace(/^(www|careers?|jobs|apply|hiring)\./, "").split(".");
  return parts[0] ?? host;
}
