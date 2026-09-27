import { randomUUID } from "node:crypto";
import type { Job } from "@jobflow/core";
import { COVER_LETTER_ANSWER_KEY, JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import {
  buildFillPlan,
  fillPlanOnPage,
  mapContactToApplicant,
  renderDryRun,
  type AutomationFlags,
} from "@jobflow/autofill";
import type { Company } from "@jobflow/core";
import {
  NaukriAdapter,
  LinkedInAdapter,
  PeerlistAdapter,
  WellfoundLocalAdapter,
  DarwinboxAdapter,
  AmbitionBoxEnricher,
  GlassdoorEnricher,
  atsAdapter,
  htmlToText,
  buildIndiaSweTargets,
  lpaFloorFromInr,
  peerlistRoleFor,
  wellfoundRoleFor,
  INDIA_SWE_QUERIES,
  type FetchTarget,
  type SourceAdapter,
  type Tier3Context,
  type Tier3PollOptions,
  type Tier3PollTarget,
} from "@jobflow/adapters";
import { DEFAULT_TENANT, defaultProfile, ingestCompany, ingestFromAdapter, type Embedder } from "@jobflow/pipeline";
import type { AgentSession } from "./session.js";
import type { EffectiveFlags } from "./flags.js";

export interface HandlerCtx {
  session: AgentSession;
  flags: EffectiveFlags;
  embedder: Embedder;
}

/**
 * Local job handlers (§7.1). Run ONLY on the agent, in the user's session, gated by
 * the effective flags. The cloud never reaches this code. form_fill stops at the
 * review screen and never submits.
 */
export async function handleLocalJob(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  if (JOB_RUNTIME[job.type] !== "local") {
    throw new Error(`${job.type} is not a local job — the agent only runs Tier-3 + form-fill.`);
  }
  if (!ctx.flags.browserOn) {
    throw new Error("Browser automation is OFF. Set JOBFLOW_BROWSER=on (env) AND enable it in web settings.");
  }

  switch (job.type) {
    case "form_fill":
      return formFill(repo, job, ctx);
    case "tier3_poll":
      return tier3Poll(repo, job, ctx);
    case "enrich_t3":
      return enrichT3(repo, job, ctx);
    case "import_yc":
      return importYc(repo, job, ctx);
    case "local_board_poll":
      return localBoardPoll(repo, job, ctx);
    default:
      throw new Error(`Unhandled local job type: ${job.type}`);
  }
}

// ── import your YC / Work-at-a-Startup profile in YOUR session (Tier-3, never cloud) ──
async function importYc(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  const url = job.payload.url as string | undefined;
  if (!url) throw new Error("import_yc requires payload.url (your WaaS/YC profile URL)");
  // auth-gated → read it in the user's own logged-in browser, then store as read-only
  // context. Best-effort text capture; it never merges into the Evidence Bank.
  const html = await ctx.session.localFetch(url);
  const text = htmlToText(html).slice(0, 6000);
  if (!text) return { imported: false, note: "no text captured — is the WaaS profile logged in / public?" };
  const existing = await repo.getContext(DEFAULT_TENANT, "yc");
  await repo.upsertContext({
    id: existing?.id ?? randomUUID(),
    tenantId: DEFAULT_TENANT,
    source: "yc",
    handle: url,
    label: "YC / Work at a Startup",
    content: text,
    items: [],
    enabled: existing?.enabled ?? true,
    syncedAt: new Date(),
  });
  return { imported: true, chars: text.length };
}

// ── form-fill → review gate, never submit ──
async function formFill(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  if (ctx.flags.mode !== "fill") {
    throw new Error("JOBFLOW_BROWSER_MODE is 'capture'. Set it to 'fill' to fill forms.");
  }
  const postingId = job.payload.postingId as string | undefined;
  if (!postingId) throw new Error("form_fill requires payload.postingId");
  const posting = await repo.getPosting(postingId);
  if (!posting?.applyUrl) throw new Error("posting has no apply URL");

  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  // prefer answers passed on the job; else fall back to the tailored answers saved on
  // the application (the "Save to application" flow on the tailor page).
  const app = await repo.getApplicationByPosting(DEFAULT_TENANT, postingId);
  const { [COVER_LETTER_ANSWER_KEY]: coverLetter, ...answers } =
    (job.payload.answers as Record<string, string> | undefined) ?? app?.answers ?? {};
  const applicant = mapContactToApplicant(profile.prefs.contact, answers);
  // the saved cover letter goes to the form's cover-letter field, not the fuzzy question matcher
  if (coverLetter?.trim()) applicant.coverLetter = coverLetter;
  // prefer this application's tailored PDF; fall back to the base résumé (§ per-role attach).
  if (app?.tailoredResumeUrl) applicant.resumePath = app.tailoredResumeUrl;
  if (!applicant.email) throw new Error("No contact email set — fill your contact details in Settings first.");

  const ats = posting.atsType === "unknown" ? "greenhouse" : posting.atsType;
  const plan = buildFillPlan(ats, posting.applyUrl, applicant);

  const flags: AutomationFlags = { browser: "on", mode: "fill", autosubmit: false, rate: ctx.flags.rate, tier3Sources: ctx.flags.enabledSources };
  const page = await ctx.session.newPage();
  const report = await fillPlanOnPage(page, plan, { flags });

  // record progress on the CRM (awaiting human review — never auto-submitted)
  if (app) {
    await repo.upsertApplication({ ...app, status: app.status === "saved" ? "drafting" : app.status, nextAction: "review & submit (form pre-filled)" });
  }
  return { filled: report.filled, answersMatched: report.answersMatched, skipped: report.skippedNoField, reviewUrl: report.reviewUrl, submitted: false, dryRunPreview: renderDryRun(plan).split("\n").slice(0, 2).join(" ") };
}

/** Tier-3 job sources the `tier3_poll` handler can browse (ambitionbox/glassdoor are enrichers). */
export const TIER3_JOB_SOURCES = ["naukri", "linkedin", "peerlist", "wellfound"] as const;

/** The session-bound fetchers every Tier-3 adapter gets (the network lives only here). */
function tier3Context(ctx: HandlerCtx): Tier3Context {
  return {
    enabledSources: ctx.flags.enabledSources,
    localFetch: (url) => ctx.session.localFetch(url),
    localFetchJson: (url, headers, init) => ctx.session.localFetchJson(url, headers, init),
  };
}

function tier3JobAdapter(source: string, tier3: Tier3Context): SourceAdapter | null {
  switch (source) {
    case "naukri":
      return new NaukriAdapter(tier3);
    case "linkedin":
      return new LinkedInAdapter(tier3);
    case "peerlist":
      return new PeerlistAdapter(tier3);
    case "wellfound":
      return new WellfoundLocalAdapter(tier3);
    default:
      return null;
  }
}

// ── Tier-3 job poll (Naukri/LinkedIn/Peerlist/Wellfound) in the user's session ──
// Naukri/LinkedIn sweep a curated "good-paying software/engineering in India" target
// matrix (query × Indian tech hub, soft CTC floor); Peerlist/Wellfound have no such
// facets, so they read a few role-family listings. All through the user's OWN session,
// human-paced and sequential. Payload overrides the defaults; the profile's INR
// salaryFloor sets the LPA floor. Biasing the source query toward higher CTC / hubs
// shapes WHAT we poll — it is not a hard match filter (invariant #4).
async function tier3Poll(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  const source = String(job.payload.source ?? "");
  if (!ctx.flags.enabledSources.includes(source)) {
    throw new Error(`Source '${source}' is not opted in. Enable it in Settings → Automation (Tier-3 sources).`);
  }
  const adapter = tier3JobAdapter(source, tier3Context(ctx));
  if (!adapter) throw new Error(`No job adapter for Tier-3 source '${source}'`);

  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  const targets: FetchTarget[] =
    source === "peerlist" || source === "wellfound"
      ? planFeedTargets(source, job.payload)
      : planTier3Targets(job.payload, profile.prefs.salaryFloor, profile.yoe).map((t) => ({
          query: t.query,
          location: t.location || undefined,
          limit: t.limit,
          params: { minLpa: t.minLpa, freshnessDays: t.freshnessDays, ...(t.experienceYears != null ? { experienceYears: t.experienceYears } : {}) },
        }));

  let fetched = 0;
  let upserted = 0;
  const errors: string[] = [];
  const sweep: Array<{ q: string; loc: string; got: number }> = [];
  for (const [i, ft] of targets.entries()) {
    if (i > 0) await politeDelay(ctx.flags.rate); // human pacing between page loads (no parallel sessions)
    const s = await ingestFromAdapter(repo, adapter, ft, { embedder: ctx.embedder });
    fetched += s.fetched;
    upserted += s.upserted;
    errors.push(...s.errors);
    sweep.push({ q: ft.query ?? "all roles", loc: ft.location || String(ft.params?.location ?? "remote/any"), got: s.fetched });
  }

  // Close the loop: browsed postings only reach the feed once matches are (re)built.
  // Enqueue a cloud `rank` — pure DB work, holds no session, so it stays invariant-#1 safe.
  if (upserted > 0) await enqueueRank(repo);
  return { source, targets: targets.length, fetched, upserted, errors: errors.slice(0, 5), sweep };
}

/** role families read per feed run unless the payload asks for more (politeness). */
const FEED_MAX_ROLES = 3;

/**
 * Peerlist / Wellfound targets: the query list (payload → env → curated India SWE set)
 * mapped onto each site's role families and deduped — neither has a city facet worth
 * sweeping, so the hub dimension is dropped. Peerlist pages are newest-first (1 page of
 * 50 per role by default); Wellfound's aren't date-sorted, so it reads 2.
 */
function planFeedTargets(source: "peerlist" | "wellfound", payload: Record<string, unknown>): FetchTarget[] {
  const queries =
    asStrArray(payload.queries) ??
    (payload.query ? [String(payload.query)] : undefined) ??
    tier3TargetEnv().queries ??
    [...INDIA_SWE_QUERIES];
  const roleOf = source === "peerlist" ? (q: string) => peerlistRoleFor(q) ?? "" : wellfoundRoleFor;
  const roles = [...new Set(queries.map(roleOf))].slice(0, asNum(payload.maxTargets) ?? FEED_MAX_ROLES);
  const maxPages = asNum(payload.maxPages) ?? (source === "peerlist" ? 1 : 2);
  const limit = asNum(payload.limit) ?? (source === "peerlist" ? 50 * maxPages : 150);
  const params: Record<string, string | number> = { maxPages };
  if (source === "wellfound") params.location = String(payload.location ?? "india");
  return roles.map((role) => ({ query: role || undefined, limit, params })); // "" → Peerlist's all-roles listing
}

/**
 * One queued `rank` covers every upsert made before it runs, so a scheduled round of
 * several local jobs doesn't stack up N identical cloud re-ranks.
 */
async function enqueueRank(repo: Repository): Promise<void> {
  const recent = await repo.listJobs(DEFAULT_TENANT, 30);
  if (recent.some((j) => j.type === "rank" && j.status === "queued")) return;
  await repo.enqueueJob({ tenantId: DEFAULT_TENANT, type: "rank", runtime: JOB_RUNTIME.rank, payload: {} });
}

// ── local-only boards (Darwinbox) in the user's session ──

/**
 * Board ATSes with no cloud adapter — polled HERE, through the same `ingestCompany`
 * the cloud uses, so the idempotent upsert + full-board staleness diff are shared (§3).
 * Adding one = an entry here + its Tier-3 board adapter (never in the cloud registry).
 */
const LOCAL_BOARDS: Partial<Record<Company["atsType"], (tier3: Tier3Context, company: Company) => SourceAdapter>> = {
  darwinbox: (tier3, company) => new DarwinboxAdapter(tier3, { companyName: company.name }),
};
export const LOCAL_BOARD_SOURCES: string[] = Object.keys(LOCAL_BOARDS);

/**
 * Poll every active registered company whose board only the agent can read (payload
 * `companyId` → just that one; `source` → just that ATS). Each board's type must be
 * opted in like any Tier-3 source. Sequential, human-paced; a board that fails returns
 * no postings and so never stales anything.
 */
async function localBoardPoll(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  const onlyCompany = job.payload.companyId ? String(job.payload.companyId) : undefined;
  const onlySource = job.payload.source ? String(job.payload.source) : undefined;
  const boards = (await repo.listCompanies({ status: "active" })).filter(
    (c) =>
      !!c.atsSlug &&
      !!LOCAL_BOARDS[c.atsType] &&
      !atsAdapter(c.atsType) && // if a cloud adapter ever exists, the cloud owns the board
      (!onlyCompany || c.id === onlyCompany) &&
      (!onlySource || c.atsType === onlySource),
  );
  const enabled = boards.filter((c) => ctx.flags.enabledSources.includes(c.atsType));
  if (boards.length && !enabled.length) {
    const kinds = [...new Set(boards.map((b) => b.atsType))].join(", ");
    throw new Error(`Local boards (${kinds}) are not opted in. Enable them in Settings → Automation (Tier-3 sources).`);
  }

  const tier3 = tier3Context(ctx);
  let fetched = 0;
  let upserted = 0;
  let staled = 0;
  const errors: string[] = [];
  const polled: Array<{ company: string; got: number; staled: number }> = [];
  for (const [i, c] of enabled.entries()) {
    if (i > 0) await politeDelay(ctx.flags.rate);
    try {
      const s = await ingestCompany(repo, c, { adapter: LOCAL_BOARDS[c.atsType]!(tier3, c), embedder: ctx.embedder });
      fetched += s.fetched;
      upserted += s.upserted;
      staled += s.staled;
      errors.push(...s.errors);
      polled.push({ company: c.name, got: s.fetched, staled: s.staled });
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  if (upserted > 0 || staled > 0) await enqueueRank(repo);
  return { boards: enabled.length, fetched, upserted, staled, errors: errors.slice(0, 5), polled };
}

/**
 * Plan the poll target matrix from (payload override → env override → profile floor).
 * A payload `query`/`queries` narrows the sweep; otherwise the curated India SWE query
 * set is used. `minLpa` defaults to the profile's INR salaryFloor expressed in LPA.
 */
function planTier3Targets(payload: Record<string, unknown>, salaryFloorInr: number, yoe: number): Tier3PollTarget[] {
  const env = tier3TargetEnv();
  const payloadQueries = asStrArray(payload.queries) ?? (payload.query ? [String(payload.query)] : undefined);
  const opts: Tier3PollOptions = {
    queries: payloadQueries ?? env.queries,
    locations: asStrArray(payload.locations) ?? (payload.location ? [String(payload.location)] : undefined) ?? env.locations,
    minLpa: asNum(payload.minLpa) ?? env.minLpa ?? lpaFloorFromInr(salaryFloorInr),
    freshnessDays: asNum(payload.freshnessDays) ?? env.freshnessDays,
    limitPerTarget: asNum(payload.limit) ?? env.limitPerTarget,
    maxTargets: asNum(payload.maxTargets) ?? env.maxTargets,
    remote: typeof payload.remote === "boolean" ? payload.remote : undefined,
    // your YoE shapes the source query (LinkedIn f_E / Naukri experience) so the sweep
    // returns roles you can land, not senior-only ones — still scored, never gated
    experienceYears: asNum(payload.experienceYears) ?? yoe,
  };
  return buildIndiaSweTargets(opts);
}

/** Optional env overrides for the Tier-3 sweep (all default off → curated defaults apply). */
function tier3TargetEnv(): Tier3PollOptions {
  return {
    queries: asCsv(process.env.JOBFLOW_TIER3_QUERIES),
    locations: asCsv(process.env.JOBFLOW_TIER3_LOCATIONS),
    minLpa: asNum(process.env.JOBFLOW_TIER3_MIN_LPA),
    freshnessDays: asNum(process.env.JOBFLOW_TIER3_FRESHNESS_DAYS),
    limitPerTarget: asNum(process.env.JOBFLOW_TIER3_LIMIT),
    maxTargets: asNum(process.env.JOBFLOW_TIER3_MAX_TARGETS),
  };
}

function asStrArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const xs = v.map((x) => String(x)).filter((x) => x.trim());
  return xs.length ? xs : undefined;
}
function asCsv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const xs = v.split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? xs : undefined;
}
function asNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function politeDelay(rate: "human" | "fast"): Promise<void> {
  const ms = rate === "fast" ? 250 + Math.random() * 250 : 1200 + Math.random() * 1800;
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tier-3 enrichment (ratings/comp) in the user's session ──
async function enrichT3(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  const source = String(job.payload.source ?? "ambitionbox");
  const companyId = job.payload.companyId as string | undefined;
  if (!companyId) throw new Error("enrich_t3 requires payload.companyId");
  if (!ctx.flags.enabledSources.includes(source)) {
    throw new Error(`Source '${source}' is not opted in (Settings → Automation).`);
  }
  const company = await repo.getCompany(companyId);
  if (!company) throw new Error("company not found");

  const tier3 = tier3Context(ctx);
  const enricher = source === "glassdoor" ? new GlassdoorEnricher(tier3) : new AmbitionBoxEnricher(tier3);
  const e = await enricher.enrich({ companyName: company.name });
  if (!e) return { source, parsed: false, note: "no ratings parsed (selectors need tuning for your session)" };

  await repo.saveCompanyEnrichment(companyId, {
    ratingOverall: e.ratingOverall ?? null,
    ratingWlb: e.ratingWlb ?? null,
    ratingComp: e.ratingComp ?? null,
    reviewCount: e.reviewCount ?? null,
    ratingSource: source,
    cultureSummary: e.cultureSummary ?? null,
    interviewDifficulty: e.interviewDifficulty ?? null,
  });
  return { source, parsed: true, rating: e.ratingOverall };
}
