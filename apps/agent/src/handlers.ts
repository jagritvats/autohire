import { randomUUID } from "node:crypto";
import type { Job } from "@jobflow/core";
import { JOB_RUNTIME } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import {
  buildFillPlan,
  fillPlanOnPage,
  mapContactToApplicant,
  renderDryRun,
  type AutomationFlags,
} from "@jobflow/autofill";
import {
  NaukriAdapter,
  LinkedInAdapter,
  AmbitionBoxEnricher,
  GlassdoorEnricher,
  htmlToText,
  type Tier3Context,
} from "@jobflow/adapters";
import { DEFAULT_TENANT, defaultProfile, ingestFromAdapter, type Embedder } from "@jobflow/pipeline";
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
  const answers = (job.payload.answers as Record<string, string> | undefined) ?? app?.answers ?? {};
  const applicant = mapContactToApplicant(profile.prefs.contact, answers);
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

// ── Tier-3 job poll (Naukri/LinkedIn) in the user's session ──
async function tier3Poll(repo: Repository, job: Job, ctx: HandlerCtx): Promise<Record<string, unknown>> {
  const source = String(job.payload.source ?? "");
  if (!ctx.flags.enabledSources.includes(source)) {
    throw new Error(`Source '${source}' is not opted in. Enable it in Settings → Automation (Tier-3 sources).`);
  }
  const tier3: Tier3Context = { enabledSources: ctx.flags.enabledSources, localFetch: (url) => ctx.session.localFetch(url) };
  const adapter =
    source === "naukri" ? new NaukriAdapter(tier3) : source === "linkedin" ? new LinkedInAdapter(tier3) : null;
  if (!adapter) throw new Error(`No job adapter for Tier-3 source '${source}'`);

  const query = (job.payload.query as string | undefined) ?? "backend developer";
  const stats = await ingestFromAdapter(repo, adapter, { query }, { embedder: ctx.embedder });
  return { source, fetched: stats.fetched, upserted: stats.upserted, errors: stats.errors };
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

  const tier3: Tier3Context = { enabledSources: ctx.flags.enabledSources, localFetch: (url) => ctx.session.localFetch(url) };
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
