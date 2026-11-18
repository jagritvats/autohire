import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import type { SourceAdapter } from "@jobflow/adapters";
import { ApplicationStatus, COVER_LETTER_ANSWER_KEY, scorePosting, type Posting } from "@jobflow/core";
import type { FileStore, Repository } from "@jobflow/db";
import { ProviderError, isOfflineProvider, redactSecrets } from "@jobflow/llm";
import { isOnboarded, loadProfile, pollAll, type PollStats } from "@jobflow/pipeline";
import {
  ApplyError,
  JobNotFoundError,
  KIND_QUESTION,
  buildApplyPlan,
  corpusEmbedder,
  findSearch,
  generateTailored,
  getFeed,
  getJob,
  listSearches,
  listTailored,
  rankTenant,
  runSearchNow,
  saveSearch,
  searchJobs,
  setupProgress,
  tenantProvider,
  toCards,
  trackApplication,
  type DraftKind,
  type FeedCard,
} from "@jobflow/service";
import { HiddenOut, JobSummaryOut, hiddenText, jobLines, payText, plain, summarize, type JobSummary } from "./dto.js";
import { buildQuery, describeQuery, isEmptyQuery } from "./query.js";
import { ToolError, TransientResults, findPosting, keepResolved } from "./refs.js";
import { StoreBusyError } from "./store.js";
import { registerPrompts } from "./prompts.js";

/**
 * JobFlow as an MCP server: AI agents (Claude Code, Claude Desktop, any MCP client) query
 * JobFlow's data layer — ATS-first discovery, freshness, honest scoring with flags,
 * grounded generation — instead of scraping job boards themselves.
 *
 * The invariants hold here exactly as in the CLI:
 *   #1 only Tier 1–2 sources are reachable (search/sync go through the cloud registry);
 *   #2 nothing here fills or sends a form — `prepare_application` is a dry-run plan and the
 *      person runs `jobflow apply <id> --fill` themselves, then reviews and sends it;
 *   #3 drafts come from JobFlow's own grounded generators, and the `tailor_application`
 *      prompt hands an agent the same HONEST_VOICE rules + the candidate's own material;
 *   #4 a query is a view: hidden counts are reported, scores are never bent;
 *   #7 every call is scoped to the one tenant this server was started for.
 * No tool output carries a secret (LLM keys live in the config, which is never returned).
 */

export interface JobflowMcpContext {
  /** the caller's tenant — the local default tenant for `jobflow mcp` */
  tenantId: string;
  /** run `fn` with the repository (opened lazily, serialised, closed when idle) */
  withRepo<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
  /** where uploaded/tailored résumé files live (for the apply plan); null = none */
  files: FileStore | null;
  /** shown by jobflow_status */
  dataDir?: string;
  /** "pglite" | "postgres" | "memory" — shown by jobflow_status */
  store?: string;
}

export interface JobflowMcpOptions {
  version?: string;
  /** search_jobs: ask these adapters instead of the registry (tests); still Tier 1–2 only */
  adapters?: SourceAdapter[];
  /** sync_sources: the poll routine (tests inject a fake; default: the bounded `pollAll`) */
  sync?: (repo: Repository, opts: { full: boolean; log: (line: string) => void }) => Promise<PollStats>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SET_MODEL_HINT =
  "Set a model once: `jobflow config set llm.provider anthropic` then `jobflow config set llm.key --stdin` (or LLM_PROVIDER + a key in .env). " +
  "Or write it with your own model via the `tailor_application` prompt, which carries the same grounding rules.";

const FIX: Record<string, string> = {
  email: "add a contact email: jobflow profile set email you@example.com",
  name: 'add your name: jobflow profile set name "First Last"',
  resume: "add a résumé file: jobflow profile import ./resume.pdf (or jobflow profile set resume-path ./resume.pdf)",
  applyUrl: "this posting has no apply link — open the listing and apply there",
  resumeFormat: "forms want a PDF/Word file, not .md/.tex/.txt — `jobflow tailor <id> --kind resume-md --pdf`, or jobflow profile set resume-path ./resume.pdf",
};

const DRAFT_KINDS = ["resume", "resume_md", "resume_latex", "cover_letter", "why_here", "interesting_problem", "about_blurb", "answer"] as const;
const DOC_KINDS: readonly DraftKind[] = ["resume", "resume_md", "resume_latex"];
const DRAFT_LABEL: Record<DraftKind, string> = {
  resume: "résumé bullet variants",
  resume_md: "Markdown résumé",
  resume_latex: "LaTeX résumé",
  cover_letter: "cover letter",
  why_here: '"why here" answer',
  interesting_problem: '"interesting problem" answer',
  about_blurb: '"about me"',
  answer: "answer",
};

// ── result helpers ──

function ok(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: plain(data) };
}

/** Every failure is a tool error the agent can read and relay — never a crash. */
function failure(e: unknown): CallToolResult {
  let msg: string;
  let hint: string | undefined;
  if (e instanceof ToolError) {
    msg = e.message;
    hint = e.hint;
  } else if (e instanceof StoreBusyError) msg = e.message;
  else if (e instanceof ProviderError) msg = e.userMessage;
  else if (e instanceof JobNotFoundError || e instanceof ApplyError) msg = e.message;
  else if (e instanceof ZodError) {
    const i = e.issues[0];
    msg = `invalid value${i?.path.length ? ` for ${i.path.join(".")}` : ""}: ${i?.message ?? e.message}`;
  } else msg = (e as Error)?.message ?? String(e);
  const text = redactSecrets(hint ? `${msg}\n${hint}` : msg);
  return { isError: true, content: [{ type: "text", text }] };
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return failure(e);
  }
}

const iso = (d: unknown): string | null => (d == null ? null : new Date(d as string | Date).toISOString());

function parseDue(due: string): Date {
  const d = new Date(due);
  if (!/^\d{4}-\d{2}-\d{2}/.test(due.trim()) || Number.isNaN(d.getTime())) throw new ToolError(`due must be a date like 2026-12-01 (got "${due}")`);
  return d;
}

// ── shared output pieces ──

const ApplicationOut = z.object({
  postingId: z.string(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  status: z.string(),
  nextAction: z.string().nullable(),
  nextActionAt: z.string().nullable(),
  appliedAt: z.string().nullable().describe("when the user marked it applied (JobFlow never sends applications itself)"),
  note: z.string().nullable(),
  applyUrl: z.string().nullable(),
});

const JobDetailOut = {
  job: JobSummaryOut,
  inCorpus: z.boolean().describe("false = a search_jobs result not saved yet; acting on it (track/prepare/draft) saves it"),
  scored: z.boolean(),
  description: z.string(),
  descriptionTruncated: z.boolean(),
  descriptionChars: z.number(),
  requirements: z.object({ must: z.array(z.string()), nice: z.array(z.string()) }),
  fit: z
    .object({
      whyFit: z.string().nullable(),
      gap: z.string().nullable(),
      breakdown: z.record(z.number()).nullable().describe("score components, each 0..1 (semantic, stackAdjacency, archetype, seniority, location, freshness, salary, sourceTrust)"),
    })
    .nullable(),
  freshness: z.object({
    postedAt: z.string().nullable().describe("the source's (earliest seen) publish date"),
    firstSeen: z.string().nullable(),
    lastSeen: z.string().nullable().describe("last time a poll re-confirmed it is still listed"),
    ageDays: z.number(),
    status: z.string(),
  }),
  tracker: ApplicationOut.nullable(),
  drafts: z.array(z.object({ kind: z.string(), source: z.string(), model: z.string(), stale: z.boolean(), createdAt: z.string() })),
  apply: z
    .object({
      ready: z.boolean().describe("name, email and a PDF/Word résumé are set and there is an apply link"),
      applyUrl: z.string().nullable(),
      missing: z.array(z.object({ gap: z.string(), fix: z.string() })),
      willFill: z.array(z.string()),
      leftForYou: z.array(z.string()),
      resume: z.object({ source: z.string(), fileName: z.string().nullable(), exists: z.boolean() }),
      coverLetter: z.boolean(),
      savedAnswers: z.number(),
    })
    .nullable(),
  next: z.array(z.string()).describe("suggested next tool calls / commands"),
};

export async function jobDetail(
  repo: Repository,
  ctx: JobflowMcpContext,
  transient: TransientResults,
  ref: string,
  maxChars = 6000,
): Promise<Record<string, unknown> & { job: JobSummary; description: string; descriptionTruncated: boolean; next: string[] }> {
  const { posting, transient: isTransient } = await findPosting(repo, ctx.tenantId, transient, ref);
  const cut = (s: string) => ({ description: s.length > maxChars ? `${s.slice(0, maxChars)}…` : s, descriptionTruncated: s.length > maxChars, descriptionChars: s.length });
  const freshness = (p: Posting, ageDays: number) => ({
    postedAt: iso(p.postedAt),
    firstSeen: iso(p.firstSeen),
    lastSeen: iso(p.lastSeen),
    ageDays,
    status: p.status,
  });
  const reqs = {
    must: posting.requirements.filter((r) => r.strength === "must_have").map((r) => r.skill),
    nice: posting.requirements.filter((r) => r.strength !== "must_have").map((r) => r.skill),
  };

  if (isTransient) {
    // a search result: read-only — score it in memory, save nothing
    const profile = await loadProfile(repo, ctx.tenantId);
    const scored = isOnboarded(profile);
    const s = scored ? scorePosting(posting, profile) : null;
    const [card] = await toCards(repo, ctx.tenantId, [
      { posting, match: s ? { score: s.score, levelNote: s.flags.levelNote, stackNote: s.flags.stack.note, redFlags: s.flags.redFlags } : null },
    ]);
    const job = summarize(card!, scored);
    return {
      job,
      inCorpus: false,
      scored,
      ...cut(posting.jdText ?? ""),
      requirements: reqs,
      fit: s ? { whyFit: s.flags.stack.note, gap: null, breakdown: s.breakdown } : null,
      freshness: freshness(posting, job.ageDays),
      tracker: null,
      drafts: [],
      apply: null,
      next: [`track_application {"id":"${posting.id}"} saves it to your corpus and tracker`, `prepare_application {"id":"${posting.id}"}`],
    };
  }

  const d = await getJob(repo, ctx.files, ctx.tenantId, posting.id);
  const match = d.scored ? ((await repo.listMatchesForPostings(ctx.tenantId, [posting.id]))[0] ?? null) : null;
  const app = d.application ? await repo.getApplicationByPosting(ctx.tenantId, posting.id) : null;
  const job = summarize(d.card, d.scored);
  const missing = d.apply.missing.map((m) => ({ gap: m, fix: (FIX[m] ?? m).replace("<id>", posting.id) }));
  const id = posting.id;
  const next = !app
    ? [`track_application {"id":"${id}"}`, `draft_document {"id":"${id}","kind":"resume_md"}`, `prepare_application {"id":"${id}"}`]
    : ["saved", "drafting", "ready"].includes(app.status)
      ? [`draft_document {"id":"${id}","kind":"cover_letter"}`, `prepare_application {"id":"${id}"}`, `the user runs: jobflow apply ${id} --fill`]
      : [`track_application {"id":"${id}","nextAction":"follow up","due":"YYYY-MM-DD"}`];
  return {
    job,
    inCorpus: true,
    scored: d.scored,
    ...cut(d.description ?? ""),
    requirements: d.requirements,
    fit: match ? { whyFit: match.whyFit, gap: match.gap, breakdown: match.scoreBreakdown } : null,
    freshness: freshness(posting, job.ageDays),
    tracker: app ? appOut(app, posting) : null,
    drafts: d.drafts,
    apply: {
      ready: missing.length === 0,
      applyUrl: d.apply.applyUrl,
      missing,
      willFill: d.apply.willFill,
      leftForYou: d.apply.leftForYou,
      resume: d.apply.resume,
      coverLetter: d.apply.coverLetter,
      savedAnswers: d.apply.answers,
    },
    next,
  };
}

function appOut(
  a: { postingId: string; status: string; nextAction: string | null; nextActionAt: unknown; submittedAt: unknown; outcome: string | null },
  p: Pick<Posting, "title" | "companyName" | "applyUrl"> | null,
): z.infer<typeof ApplicationOut> {
  return {
    postingId: a.postingId,
    title: p?.title ?? null,
    company: p?.companyName ?? null,
    status: a.status,
    nextAction: a.nextAction,
    nextActionAt: iso(a.nextActionAt),
    appliedAt: iso(a.submittedAt),
    note: a.outcome,
    applyUrl: p?.applyUrl ?? null,
  };
}

function profileOut(p: Awaited<ReturnType<typeof loadProfile>>, evidence: Array<{ project: string; headline: string; detail: string; metric: string | null; tags: string[] }>) {
  const c = p.prefs.contact;
  return {
    onboarded: isOnboarded(p),
    name: [c.firstName, c.lastName].filter((s) => s.trim()).join(" "),
    contact: { email: c.email, phone: c.phone, linkedin: c.linkedin, github: c.github, portfolio: c.portfolio },
    yearsExperience: p.yoe,
    level: p.levelBand,
    skills: p.prefs.stackProfile,
    mustHaveSkills: p.prefs.stackMustHaves,
    targetRoles: p.prefs.targetArchetypes,
    homeCountry: p.prefs.homeCountry,
    markets: p.prefs.markets,
    remoteOk: p.prefs.remoteGeoOk,
    relocate: p.prefs.relocate,
    salaryFloor: p.prefs.salaryFloor > 0 ? { amount: p.prefs.salaryFloor, currency: p.prefs.currency } : null,
    locations: p.prefs.locationWeights,
    resumeFile: p.resumeFile?.filename ?? (c.resumePath || null),
    resumeText: (p.masterResume ?? "").slice(0, 12_000),
    about: p.aboutText ?? "",
    evidence: evidence.map((e) => ({ project: e.project, headline: e.headline, detail: e.detail, metric: e.metric, tags: e.tags })),
  };
}

// ── the server ──

export function createJobflowMcpServer(ctx: JobflowMcpContext, opts: JobflowMcpOptions = {}): McpServer {
  const server = new McpServer(
    { name: "jobflow", title: "JobFlow", version: opts.version ?? "0.1.0" },
    {
      instructions: [
        "JobFlow is the user's local job-search data layer: ATS-first discovery, freshness and liveness checks, honest fit scores with flags, and résumé/letter drafting grounded in the user's own material.",
        "Start with jobflow_status. list_jobs is the user's ranked feed; search_jobs asks live job sources now; get_job shows one role in full.",
        "Scores are 0–100 against the user's profile; cite the redFlags/fit notes honestly, and label estimated pay as an estimate.",
        "JobFlow never submits applications and no tool fills a form: prepare_application returns a dry-run plan, and the user runs `jobflow apply <id> --fill` and reviews and sends the form themselves.",
        "Anything you write for the user must rest on their own material (use draft_document, or the tailor_application prompt if you write it yourself) — rephrase, reorder, trim; never invent.",
      ].join("\n"),
    },
  );
  const transient = new TransientResults();
  const { tenantId } = ctx;

  // ── jobflow_status ──
  server.registerTool(
    "jobflow_status",
    {
      title: "Where the user is in JobFlow",
      description:
        "Setup progress and the one next step: is a profile set up (jobs can only be scored against one), has a sync filled the corpus, are there saved searches, tracked applications, follow-ups due, and is a generation model configured. Call this first.",
      inputSchema: {},
      outputSchema: {
        profile: z.object({ onboarded: z.boolean(), name: z.string(), missing: z.array(z.string()), evidence: z.number(), skills: z.number() }),
        corpus: z.object({ postings: z.number(), matches: z.number(), lastSyncAt: z.string().nullable(), syncing: z.boolean() }),
        savedSearches: z.number(),
        applications: z.object({ total: z.number(), applied: z.number(), dueFollowUps: z.number() }),
        model: z.object({ configured: z.boolean(), provider: z.string() }),
        steps: z.array(z.object({ id: z.string(), done: z.boolean(), title: z.string(), detail: z.string(), cli: z.string() })),
        next: z.object({ title: z.string(), detail: z.string(), cli: z.string(), tool: z.string().nullable() }).nullable(),
        store: z.string().nullable(),
      },
      annotations: { title: "JobFlow status", ...READ_ONLY },
    },
    () =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const p = await setupProgress(repo, tenantId);
          const toolFor: Record<string, string | null> = { profile: null, sync: "sync_sources", search: "save_search", track: "track_application" };
          let next = p.next ? { title: p.next.title, detail: p.next.detail, cli: p.next.cli, tool: toolFor[p.next.id] ?? null } : null;
          if (!next && p.applications.dueFollowUps) next = { title: "Follow up", detail: `${p.applications.dueFollowUps} follow-up(s) are due.`, cli: "jobflow track", tool: "list_applications" };
          const store = ctx.store ? `${ctx.store}${ctx.dataDir && ctx.store === "pglite" ? ` (${ctx.dataDir})` : ""}` : null;
          const lines = [
            `Profile: ${p.profile.onboarded ? `${p.profile.name || "(no name)"} · ${p.profile.skills} skills · ${p.profile.evidence} evidence items${p.profile.missing.length ? ` · missing: ${p.profile.missing.join(", ")}` : ""}` : "not set up — jobs can't be scored yet (the user runs `jobflow init`, or `jobflow init --sample` for the fictional demo persona)"}`,
            `Jobs: ${p.corpus.postings} postings${p.corpus.postings ? (p.profile.onboarded ? (p.corpus.matches ? " · ranked" : " · not ranked yet") : " · unscored") : ""}${p.corpus.lastSyncAt ? ` · last sync ${p.corpus.lastSyncAt.slice(0, 16).replace("T", " ")} UTC` : " · never synced"}`,
            `Saved searches: ${p.searches}`,
            `Applications: ${p.applications.total} tracked · ${p.applications.applied} applied${p.applications.dueFollowUps ? ` · ${p.applications.dueFollowUps} follow-up(s) due` : ""}`,
            `Model: ${p.model.configured ? p.model.provider : "none (offline) — ranking and résumé templates work; cover letters/answers need a model"}`,
          ];
          if (next) lines.push(`Next: ${next.title} — ${next.detail}${next.tool ? ` (tool: ${next.tool})` : ""} · CLI: ${next.cli}`);
          return ok(lines.join("\n"), {
            profile: { ...p.profile, missing: p.profile.missing as string[] },
            corpus: p.corpus,
            savedSearches: p.searches,
            applications: p.applications,
            model: p.model,
            steps: p.steps.map(({ id, done, title, detail, cli }) => ({ id, done, title, detail, cli })),
            next,
            store,
          });
        }),
      ),
  );

  // ── search_jobs ──
  const strs = (d: string) => z.array(z.string()).optional().describe(d);
  server.registerTool(
    "search_jobs",
    {
      title: "Search live job sources",
      description:
        "Ask JobFlow's search-capable job sources (public ATS boards and feeds — Tier 1–2 only) right now, and score every result against the user's profile with the same honest scorer as the feed. " +
        'Give `query` as free text — it accepts the CLI\'s flag syntax, e.g. `"backend engineer" --remote --posted 7d --min-salary "40L INR"` — and/or the structured fields. ' +
        "The query is a VIEW: what it hides is counted per reason, never silently dropped, and no score is bent. Results not yet in the user's feed are transient: get_job reads them; track_application / prepare_application / draft_document save them. Takes 5–30 s.",
      inputSchema: {
        query: z.string().optional().describe('free text, may include CLI flags: --remote, --onsite, --loc "Berlin,DE", --country US, --seniority senior, --min-salary "150k USD", --posted 7d, --must kafka, --title, --exclude-company, --preset india, --sources remotive'),
        keywords: strs("phrases to look for (each is one phrase)"),
        titles: strs("title must contain one of these"),
        remote: z.enum(["only", "exclude", "any"]).optional().describe("only = remote roles only; exclude = no remote roles"),
        locations: strs('places: "Berlin,DE", "US", "Bengaluru"'),
        countries: strs("ISO-2 country codes"),
        seniority: strs("junior | mid | senior | staff | principal …"),
        minSalary: z.string().optional().describe('e.g. "150000 USD", "150k USD", "40L INR" — hides only roles that STATE less'),
        postedWithinDays: z.number().int().min(1).max(365).optional(),
        mustSkills: strs("skills the role must mention"),
        niceSkills: strs("skills that are a plus"),
        excludeCompanies: strs("companies to hide"),
        excludeKeywords: strs("hide roles mentioning these"),
        presets: strs("discovery-preset tags: india, us, eu-uk, global-remote (searches their feeds)"),
        sources: strs("only these sources, e.g. remotive, himalayas"),
        limit: z.number().int().min(1).max(50).default(15),
        sort: z.enum(["score", "relevance"]).default("score"),
        ingest: z.boolean().default(false).describe("also add every result to the user's corpus/feed (default false: searching writes nothing)"),
      },
      outputSchema: {
        query: z.string().describe("how JobFlow read the query"),
        scored: z.boolean().describe("false before the user's profile is set up: no scores, fit notes or hard exclusions"),
        results: z.array(JobSummaryOut.extend({ relevance: z.number().describe("0..1 match to the query terms (separate from the fit score)"), inFeed: z.boolean() })),
        fetched: z.number(),
        bySource: z.record(z.number()),
        sources: z.array(z.string()),
        hidden: HiddenOut,
        hiddenTotal: z.number(),
        hardExcluded: z.number().describe("removed by the scorer's only two hard rules: stated pay below the user's floor, or a location they can't work from"),
        errors: z.array(z.string()),
        ingested: z.number().nullable(),
      },
      annotations: { title: "Search live job sources", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      guard(async () => {
        const query = buildQuery(args);
        if (isEmptyQuery(query)) throw new ToolError('Say what to search for: a `query` like "backend engineer" (or keywords/titles/mustSkills/presets).');
        return ctx.withRepo(async (repo) => {
          const r = await searchJobs(repo, tenantId, query, { ingest: args.ingest, limit: args.limit, sort: args.sort, withPostings: true, adapters: opts.adapters });
          const postings = r.postings ?? [];
          const fresh: Posting[] = [];
          for (const [i, c] of r.cards.entries()) {
            const p = postings[i];
            if (!p || c.inFeed) continue;
            if (args.ingest) {
              const stored = (await repo.findPostingsByAtsIds(p.atsType, [p.atsJobId]))[0];
              if (stored) c.id = stored.id;
            } else fresh.push(p);
          }
          transient.remember(fresh);
          const results = r.cards.map((c) => ({ ...summarize(c, r.scored), relevance: Math.round(c.relevance * 100) / 100, inFeed: c.inFeed || !!args.ingest }));
          const desc = describeQuery(r.query);
          const sourcesHit = Object.values(r.bySource).filter((n) => n > 0).length;
          const lines: string[] = [];
          if (!results.length) {
            lines.push(
              r.fetched === 0
                ? `No results for ${desc} (${sourcesHit}/${r.sources.length} sources answered).${r.errors.length ? ` Errors: ${r.errors.slice(0, 3).join("; ")}` : ""}`
                : `Fetched ${r.fetched} posting(s) for ${desc}, but none passed: ${r.hiddenTotal} hidden by the query, ${r.excluded} hard-excluded.`,
            );
          } else {
            lines.push(`${results.length} result(s) for ${desc} · ${r.fetched} fetched from ${sourcesHit}/${r.sources.length} sources${r.scored ? " · scored against the user's profile" : " · UNSCORED (no profile yet)"}`);
            lines.push("");
            results.forEach((j, i) => lines.push(jobLines(j, i + 1) + (j.inFeed ? "" : "\n   (not in the feed yet)")));
          }
          const h = hiddenText(r.hidden, r.hiddenTotal, "The query");
          if (h) lines.push("", h);
          if (r.excluded) lines.push(`${r.excluded} hard-excluded (stated pay below the floor, or a location the user can't work from).`);
          if (r.errors.length && results.length) lines.push(`Some sources failed: ${r.errors.slice(0, 3).join("; ")}`);
          if (args.ingest) lines.push(`Added ${r.ingested ?? 0} posting(s) to the corpus.`);
          return ok(lines.join("\n"), {
            query: desc,
            scored: r.scored,
            results,
            fetched: r.fetched,
            bySource: r.bySource,
            sources: r.sources,
            hidden: r.hidden,
            hiddenTotal: r.hiddenTotal,
            hardExcluded: r.excluded,
            errors: r.errors.map((x) => redactSecrets(x)).slice(0, 20),
            ingested: args.ingest ? (r.ingested ?? 0) : null,
          });
        });
      }),
  );

  // ── list_jobs ──
  server.registerTool(
    "list_jobs",
    {
      title: "The user's ranked feed",
      description:
        "The user's feed from their corpus (filled by sync_sources), best fit first. Before the profile is set up it's an unscored browse feed (freshest, most trustworthy). " +
        "Filter with minScore, presets (tags) or a savedSearch used as a view — whatever a view hides is counted per reason. Roles already applied to are left out unless includeApplied.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        minScore: z.number().min(0).max(100).optional(),
        presets: z.array(z.string()).optional().describe("only roles tagged with these presets: india, us, eu-uk, global-remote"),
        savedSearch: z.string().optional().describe("a saved search's name (or id) to view the feed through"),
        includeApplied: z.boolean().default(false),
      },
      outputSchema: {
        mode: z.enum(["ranked", "browse"]).describe("browse = unscored (no profile yet)"),
        jobs: z.array(JobSummaryOut),
        postings: z.number().describe("active postings in the corpus"),
        lastSyncAt: z.string().nullable(),
        hidden: HiddenOut,
        hiddenTotal: z.number(),
        appliedHidden: z.number(),
      },
      annotations: { title: "List ranked jobs", ...READ_ONLY },
    },
    (args) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const presets = [...new Set((args.presets ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean))];
          if (presets.length) buildQuery({ presets, keywords: ["x"] }); // validates the preset ids
          let view: string | { presets: string[] } | Record<string, unknown> | null = null;
          if (args.savedSearch) {
            const s = await findSearch(repo, tenantId, args.savedSearch);
            if (!s) throw new ToolError(`No saved search "${args.savedSearch}".`, "See them with list_saved_searches.");
            view = presets.length ? { ...s.query, presets } : s.id;
          } else if (presets.length) view = { presets };
          const data = await getFeed(repo, tenantId, { limit: Math.max(args.limit * 4, 100), view: view as never, bootstrap: false });
          const scored = data.stats.mode === "ranked";
          const visible = data.cards.filter((c) => !c.archived && (args.minScore == null || c.score >= args.minScore));
          const appliedHidden = args.includeApplied ? 0 : visible.filter((c) => c.applied).length;
          const cards = visible.filter((c) => args.includeApplied || !c.applied).slice(0, args.limit);
          const jobs = cards.map((c) => summarize(c, scored));
          const lines: string[] = [];
          if (!data.stats.postings) lines.push("The corpus is empty. Fill it with sync_sources (a minute or two), or search live with search_jobs.");
          else {
            if (!scored) lines.push("Browse mode — not scored yet: the user's profile isn't set up (`jobflow init`).");
            lines.push(`${jobs.length} job(s)${scored ? " ranked for the user" : " (freshest first)"} · ${data.stats.postings} postings in the corpus${data.stats.lastPolledAt ? ` · last sync ${data.stats.lastPolledAt.slice(0, 10)}` : ""}`);
            lines.push("");
            jobs.forEach((j, i) => lines.push(jobLines(j, i + 1)));
          }
          const h = hiddenText(data.stats.hidden, data.stats.hiddenTotal, args.savedSearch ? `Saved search "${args.savedSearch}"` : "The preset filter");
          if (h) lines.push("", h);
          if (appliedHidden) lines.push(`${appliedHidden} role(s) already applied to are left out (includeApplied: true shows them).`);
          return ok(lines.join("\n"), {
            mode: scored ? "ranked" : "browse",
            jobs,
            postings: data.stats.postings,
            lastSyncAt: data.stats.lastPolledAt,
            hidden: data.stats.hidden ?? {},
            hiddenTotal: data.stats.hiddenTotal ?? 0,
            appliedHidden,
          });
        }),
      ),
  );

  // ── get_job ──
  server.registerTool(
    "get_job",
    {
      title: "One job in full",
      description:
        "Everything about one posting: the job description (truncated to maxDescriptionChars, flagged), must-have / nice-to-have skills, the fit breakdown and notes, red flags, pay (stated vs estimate), freshness, tracker status, saved drafts, and the apply checklist (what's missing before the form can be pre-filled). Accepts a full id or a unique prefix.",
      inputSchema: {
        id: z.string().describe("posting id or a unique prefix (≥ 4 characters)"),
        maxDescriptionChars: z.number().int().min(200).max(50_000).default(6000),
      },
      outputSchema: JobDetailOut,
      annotations: { title: "Get one job", ...READ_ONLY },
    },
    (args) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const d = await jobDetail(repo, ctx, transient, args.id, args.maxDescriptionChars);
          const j = d.job;
          const fit = d.fit as { whyFit: string | null; gap: string | null } | null;
          const apply = d.apply as { ready: boolean; missing: Array<{ gap: string; fix: string }> } | null;
          const tracker = d.tracker as { status: string; nextAction: string | null } | null;
          const reqs = d.requirements as { must: string[]; nice: string[] };
          const lines = [
            jobLines(j),
            reqs.must.length ? `Must-haves: ${reqs.must.join(", ")}` : null,
            fit?.whyFit ? `Why: ${fit.whyFit}` : null,
            fit?.gap ? `Gap: ${fit.gap}` : null,
            `Tracker: ${tracker ? `${tracker.status}${tracker.nextAction ? ` · next: ${tracker.nextAction}` : ""}` : d.inCorpus ? "not tracked" : "not in the corpus (a search result)"}`,
            apply ? (apply.ready ? "Ready to pre-fill: name, email and a résumé file are set." : `Not ready to pre-fill — ${apply.missing.map((m) => `${m.gap}: ${m.fix}`).join("; ")}`) : null,
            "",
            d.description || "(no description)",
            d.descriptionTruncated ? `\n[description truncated — ${d.descriptionChars} chars; raise maxDescriptionChars for more]` : null,
            "",
            `Next: ${d.next.join(" · ")}`,
          ].filter((l) => l != null);
          return ok(lines.join("\n"), d);
        }),
      ),
  );

  // ── saved searches ──
  const SavedSearchOut = z.object({
    id: z.string(),
    name: z.string(),
    query: z.string(),
    enabled: z.boolean(),
    runsOnSync: z.boolean(),
    lastRunAt: z.string().nullable(),
  });
  server.registerTool(
    "list_saved_searches",
    {
      title: "Saved searches",
      description: "The user's saved searches. Each one runs on every sync (fetching from its sources into the corpus) and works as a feed view (list_jobs savedSearch).",
      inputSchema: {},
      outputSchema: { searches: z.array(SavedSearchOut) },
      annotations: { title: "List saved searches", ...READ_ONLY },
    },
    () =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const all = await listSearches(repo, tenantId);
          const searches = all.map((s) => ({ id: s.id, name: s.name, query: describeQuery(s.query), enabled: s.enabled, runsOnSync: s.asSource, lastRunAt: iso(s.lastRunAt) }));
          const text = searches.length
            ? searches.map((s) => `- ${s.name}: ${s.query}${s.enabled ? "" : " (disabled)"} · last run ${s.lastRunAt?.slice(0, 16).replace("T", " ") ?? "never"}`).join("\n")
            : "No saved searches yet. save_search adds one.";
          return ok(text, { searches });
        }),
      ),
  );

  server.registerTool(
    "save_search",
    {
      title: "Save a search",
      description:
        'Save (or replace, by name) a search: it then runs on every sync and becomes a feed view. `query` uses the same syntax as search_jobs, e.g. `"backend engineer" --remote --posted 7d`. Saving replaces the query of an existing search with the same name.',
      inputSchema: {
        name: z.string().min(1).max(80),
        query: z.string().min(1).describe("free text with optional CLI flags, as for search_jobs"),
        runOnSync: z.boolean().default(true).describe("false = only use it as a feed view (don't poll sources with it)"),
      },
      outputSchema: { search: SavedSearchOut, replaced: z.boolean() },
      annotations: { title: "Save a search", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      guard(async () => {
        const query = buildQuery({ query: args.query });
        if (isEmptyQuery(query)) throw new ToolError('The query needs words to look for, e.g. "backend engineer" --remote.');
        return ctx.withRepo(async (repo) => {
          const existing = await findSearch(repo, tenantId, args.name);
          const s = await saveSearch(repo, tenantId, { id: existing?.id, name: args.name, query, asSource: args.runOnSync });
          const out = { id: s.id, name: s.name, query: describeQuery(s.query), enabled: s.enabled, runsOnSync: s.asSource, lastRunAt: iso(s.lastRunAt) };
          return ok(`${existing ? "Updated" : "Saved"} "${s.name}": ${out.query}. Run it now with run_saved_search; view it with list_jobs savedSearch="${s.name}".`, {
            search: out,
            replaced: !!existing,
          });
        });
      }),
  );

  server.registerTool(
    "run_saved_search",
    {
      title: "Run a saved search now",
      description: "Fetch from a saved search's sources into the corpus now (idempotent upserts), then re-rank the feed. Hits live job sources; may take a minute.",
      inputSchema: { name: z.string().describe("the saved search's name (or id)") },
      outputSchema: { name: z.string(), fetched: z.number(), saved: z.number(), bySource: z.record(z.number()), errors: z.array(z.string()) },
      annotations: { title: "Run a saved search", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const s = await findSearch(repo, tenantId, args.name);
          if (!s) throw new ToolError(`No saved search "${args.name}".`, "See them with list_saved_searches.");
          const r = await runSearchNow(repo, tenantId, s.id);
          const by = Object.entries(r.bySource).filter(([, n]) => n > 0);
          return ok(
            `"${s.name}": ${r.fetched} fetched, ${r.upserted} saved to the corpus${by.length ? ` (${by.map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}.${r.errors.length ? ` Errors: ${r.errors.slice(0, 3).join("; ")}` : ""} View: list_jobs savedSearch="${s.name}".`,
            { name: s.name, fetched: r.fetched, saved: r.upserted, bySource: r.bySource, errors: r.errors.map((x) => redactSecrets(x)).slice(0, 20) },
          );
        }),
      ),
  );

  // ── tracker ──
  server.registerTool(
    "track_application",
    {
      title: "Track an application",
      description:
        `Start tracking a posting, or update it: status (${ApplicationStatus.options.join(", ")}), a note, and the next action with a due date (YYYY-MM-DD) for follow-ups. ` +
        'Set "applied" only when the user tells you they sent it themselves — JobFlow never submits, so it can\'t know. A search_jobs result is saved to the corpus first.',
      inputSchema: {
        id: z.string().describe("posting id or unique prefix"),
        status: ApplicationStatus.optional(),
        note: z.string().max(2000).optional().describe("e.g. who replied, the outcome"),
        nextAction: z.string().max(200).optional().describe('e.g. "follow up with the recruiter"'),
        due: z.string().optional().describe("YYYY-MM-DD for the next action"),
        clearNextAction: z.boolean().default(false),
      },
      outputSchema: { application: ApplicationOut, created: z.boolean(), keptFromSearch: z.boolean() },
      annotations: { title: "Track an application", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      guard(async () => {
        const due = args.due ? parseDue(args.due) : undefined;
        return ctx.withRepo(async (repo) => {
          const { posting, kept } = await keepResolved(repo, tenantId, transient, args.id);
          const existing = await repo.getApplicationByPosting(tenantId, posting.id);
          const app = await trackApplication(repo, tenantId, posting.id, {
            ...(args.status ? { status: args.status } : existing ? {} : { status: "saved" }),
            ...(args.note != null ? { outcome: args.note } : {}),
            ...(args.clearNextAction ? { nextAction: null, nextActionAt: null } : {}),
            ...(args.nextAction != null ? { nextAction: args.nextAction } : {}),
            ...(due ? { nextActionAt: due } : {}),
          });
          const out = appOut(app, posting);
          const text =
            `${existing ? "Updated" : "Now tracking"} ${posting.title} · ${posting.companyName}: ${app.status}` +
            (app.nextAction ? ` · next: ${app.nextAction}${out.nextActionAt ? ` (due ${out.nextActionAt.slice(0, 10)})` : ""}` : "") +
            (kept ? `\nSaved this search result to the corpus; its id there is ${posting.id}.` : "");
          return ok(text, { application: out, created: !existing, keptFromSearch: kept });
        });
      }),
  );

  server.registerTool(
    "list_applications",
    {
      title: "The user's applications",
      description: "Everything the user is tracking, next actions first (due follow-ups at the top), optionally only one status.",
      inputSchema: { status: ApplicationStatus.optional() },
      outputSchema: { applications: z.array(ApplicationOut), dueFollowUps: z.number() },
      annotations: { title: "List applications", ...READ_ONLY },
    },
    (args) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const now = Date.now();
          const closed = (s: string) => ["rejected", "withdrawn", "ghosted"].includes(s);
          const key = (a: { status: string; nextActionAt: unknown }) => (closed(a.status) ? 1e15 : 0) + (a.nextActionAt ? new Date(a.nextActionAt as string | Date).getTime() : 1e14);
          const apps = (await repo.listApplicationsWithPosting(tenantId)).filter((a) => !args.status || a.status === args.status).sort((a, b) => key(a) - key(b));
          const applications = apps.map((a) => appOut(a, a.posting));
          const due = apps.filter((a) => a.nextActionAt && new Date(a.nextActionAt as string | Date).getTime() <= now && !closed(a.status)).length;
          const text = applications.length
            ? applications
                .map((a) => `- ${a.status.padEnd(12)} ${a.title ?? "(posting removed)"} · ${a.company ?? ""}${a.nextAction ? ` · next: ${a.nextAction}${a.nextActionAt ? ` (${a.nextActionAt.slice(0, 10)})` : ""}` : ""} · id ${a.postingId}`)
                .join("\n") + (due ? `\n${due} follow-up(s) due.` : "")
            : args.status
              ? `Nothing with status "${args.status}".`
              : "Nothing tracked yet. track_application adds a role.";
          return ok(text, { applications, dueFollowUps: due });
        }),
      ),
  );

  // ── prepare_application (a dry-run plan; nothing is filled) ──
  server.registerTool(
    "prepare_application",
    {
      title: "Plan an application (dry run)",
      description:
        "The apply plan for one posting, as a dry run: the form URL, which fields would be filled with which of the user's stored values, which résumé file would be attached, saved answers and cover letter, and what's missing (with the fix). " +
        "Nothing is opened, filled or sent. To pre-fill the form, the user runs the returned `jobflow apply <id> --fill` themselves; it stops at the review screen. JobFlow never submits.",
      inputSchema: { id: z.string().describe("posting id or unique prefix") },
      outputSchema: {
        posting: z.object({ id: z.string(), title: z.string(), company: z.string() }),
        applyUrl: z.string().nullable(),
        ready: z.boolean(),
        missing: z.array(z.object({ gap: z.string(), fix: z.string() })),
        resume: z.object({ path: z.string().nullable(), source: z.string(), exists: z.boolean() }),
        coverLetter: z.boolean(),
        fields: z.array(z.object({ field: z.string(), value: z.string(), isFile: z.boolean() })).describe("what the form-filler would type, where"),
        questions: z.array(z.object({ question: z.string(), answer: z.string() })),
        leftForYou: z.array(z.string()).describe("fields with no stored value — the user fills them at review"),
        dryRun: z.string(),
        commands: z.object({ fill: z.string(), open: z.string(), markApplied: z.string() }),
        tracker: z.string().nullable(),
        keptFromSearch: z.boolean(),
      },
      annotations: { title: "Plan an application (dry run)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const { posting, kept } = await keepResolved(repo, tenantId, transient, args.id);
          const ap = await buildApplyPlan(repo, ctx.files, tenantId, posting.id);
          const id = posting.id;
          const missing = ap.missing.map((m) => ({ gap: m, fix: (FIX[m] ?? m).replace("<id>", id) }));
          const commands = { fill: `jobflow apply ${id} --fill`, open: `jobflow apply ${id} --open`, markApplied: `jobflow track status ${id} applied` };
          const data = {
            posting: { id, title: posting.title, company: posting.companyName },
            applyUrl: ap.applyUrl,
            ready: missing.length === 0,
            missing,
            resume: ap.resume,
            coverLetter: ap.coverLetter,
            fields: (ap.plan?.fields ?? []).map((f) => ({ field: f.field, value: f.value, isFile: f.isFile })),
            questions: ap.plan?.questionFields ?? [],
            leftForYou: ap.plan?.unfilled ?? [],
            dryRun: ap.dryRun,
            commands,
            tracker: ap.application?.status ?? null,
            keptFromSearch: kept,
          };
          const lines = [
            `Apply plan (dry run) · ${posting.title} · ${posting.companyName}`,
            `Form: ${ap.applyUrl ?? "no apply link"}`,
            `Résumé: ${ap.resume.path ? `${ap.resume.path} (${ap.resume.source === "tailored" ? "tailored for this role" : "base résumé"})${ap.resume.exists ? "" : " — FILE NOT FOUND"}` : "none to attach"}`,
            `Cover letter: ${ap.coverLetter ? "saved for this role" : "none (draft_document kind=cover_letter)"}`,
            "",
            ap.dryRun,
            missing.length ? `\nFix before filling:\n${missing.map((m) => `- ${m.gap}: ${m.fix}`).join("\n")}` : "",
            "",
            "Nothing was opened, filled or sent. JobFlow never submits.",
            `To pre-fill the form, the user runs: ${commands.fill}`,
            "(it stops at the review screen — the user checks every field and sends it themselves)",
            `Afterwards: track_application status=applied (or ${commands.markApplied}).`,
          ];
          return ok(lines.join("\n"), data);
        }),
      ),
  );

  // ── draft_document (JobFlow's own grounded generators) ──
  server.registerTool(
    "draft_document",
    {
      title: "Draft a grounded résumé / letter / answer",
      description:
        "Draft with JobFlow's own generators and the user's configured model, grounded ONLY in the user's base résumé, Evidence Bank and declared skills (rephrased, reordered, trimmed — never extended). " +
        "kinds: resume (3 bullet variants + ATS keyword coverage), resume_md, resume_latex, cover_letter, why_here, interesting_problem, about_blurb, answer (needs `question`). " +
        "With no model configured, résumés come back as deterministic built-in templates labelled `builtin`, and prose kinds return an error saying a model is needed. Drafts are cached until their inputs change.",
      inputSchema: {
        id: z.string().describe("posting id or unique prefix"),
        kind: z.enum(DRAFT_KINDS),
        question: z.string().max(1000).optional().describe("the application question (kind=answer)"),
        note: z.string().max(2000).optional().describe("cover letter: the user's own 'why this company' note to build on"),
        force: z.boolean().default(false).describe("regenerate even if a current draft is cached"),
        attach: z.boolean().default(true).describe("save a model-written letter/answer to this posting's application so `jobflow apply --fill` can type it"),
      },
      outputSchema: {
        posting: z.object({ id: z.string(), title: z.string(), company: z.string() }),
        kind: z.string(),
        source: z.enum(["llm", "builtin"]).describe("builtin = a deterministic template from the user's own résumé, not tailored by a model"),
        model: z.string(),
        text: z.string().describe("the document / answer (empty for kind=resume — see variants)"),
        variants: z
          .object({
            startup: z.array(z.string()),
            enterprise: z.array(z.string()),
            product: z.array(z.string()),
            atsKeywordCoverage: z.number(),
            missingKeywords: z.array(z.string()).describe("JD keywords NOT in the user's material — only add them if they are true"),
          })
          .nullable(),
        warnings: z.array(z.string()),
        cached: z.boolean(),
        stale: z.boolean(),
        attachedAs: z.string().nullable(),
        keptFromSearch: z.boolean(),
      },
      annotations: { title: "Draft a grounded document", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      guard(async () => {
        const kind = args.kind as DraftKind;
        if (kind === "answer" && !args.question?.trim()) throw new ToolError('kind "answer" needs the `question`.');
        return ctx.withRepo(async (repo) => {
          const profile = await loadProfile(repo, tenantId);
          if (!isOnboarded(profile)) throw new ToolError("The user's profile isn't set up yet — there's no material to ground a draft in.", "They run `jobflow init` (or `jobflow init --sample` to try the fictional demo persona).");
          const llm = tenantProvider(await repo.getConfig(tenantId));
          if (!DOC_KINDS.includes(kind) && isOfflineProvider(llm)) {
            throw new ToolError(`Writing a ${DRAFT_LABEL[kind]} needs a generation model — the offline echo provider can't write prose (and JobFlow never passes an echo off as a draft).`, SET_MODEL_HINT);
          }
          const { posting, kept } = await keepResolved(repo, tenantId, transient, args.id);
          const d = await generateTailored(repo, tenantId, { postingId: posting.id, kind, question: args.question, note: args.note, force: args.force });
          let attachedAs: string | null = null;
          if (args.attach && !DOC_KINDS.includes(kind) && d.source === "llm" && d.text.trim()) {
            const key = kind === "cover_letter" ? COVER_LETTER_ANSWER_KEY : kind === "answer" ? args.question!.trim() : KIND_QUESTION[kind as keyof typeof KIND_QUESTION];
            const had = await repo.getApplicationByPosting(tenantId, posting.id);
            await trackApplication(repo, tenantId, posting.id, { answers: { [key]: d.text }, ...(had ? {} : { status: "drafting" }) });
            attachedAs = key;
          }
          const v = d.variants;
          const variants = v ? { startup: v.yc_startup, enterprise: v.enterprise, product: v.product, atsKeywordCoverage: v.atsKeywordCoverage, missingKeywords: v.missingKeywords } : null;
          const body = variants
            ? [
                "Startup (ownership, speed, shipped impact):",
                ...variants.startup.map((b) => `  • ${b}`),
                "Enterprise (scale, reliability, rigor):",
                ...variants.enterprise.map((b) => `  • ${b}`),
                "Product (users, outcomes):",
                ...variants.product.map((b) => `  • ${b}`),
                `ATS keyword coverage ${Math.round(variants.atsKeywordCoverage * 100)}%${variants.missingKeywords.length ? ` · not in the user's material: ${variants.missingKeywords.slice(0, 8).join(", ")} (only add them if true)` : ""}`,
              ].join("\n")
            : d.text;
          const label = d.source === "builtin" ? "builtin — a deterministic template from the user's own résumé, not tailored by a model" : `drafted by ${d.model}`;
          const text = [
            `${DRAFT_LABEL[kind]} · ${posting.title} · ${posting.companyName} · ${label}${d.cached ? " · cached" : ""}`,
            ...d.warnings.map((w) => `warning: ${w}`),
            "",
            body,
            "",
            attachedAs ? `Saved to this posting's application ("${attachedAs}") — \`jobflow apply ${posting.id} --fill\` will type it at review.` : null,
            "The user must review every line before using it: it all has to be true of them.",
          ]
            .filter((l) => l != null)
            .join("\n");
          return ok(text, {
            posting: { id: posting.id, title: posting.title, company: posting.companyName },
            kind,
            source: d.source,
            model: d.model,
            text: d.text,
            variants,
            warnings: d.warnings,
            cached: d.cached,
            stale: d.stale,
            attachedAs,
            keptFromSearch: kept,
          });
        });
      }),
  );

  // ── sync_sources ──
  server.registerTool(
    "sync_sources",
    {
      title: "Sync job sources",
      description:
        "Discover + poll what the user's discovery plan names (their presets, custom sources and saved searches; public Tier 1–2 sources only), expire postings that are gone, then re-rank the feed. " +
        "Bounded like `jobflow sync` (full: true is the slow, worker-sized sweep). Takes a minute or more; sends progress notifications when the client asks for them. Other JobFlow tools wait while it runs.",
      inputSchema: { full: z.boolean().default(false).describe("every due board and the slow feeds too — much longer") },
      outputSchema: {
        boardsPolled: z.number(),
        fetched: z.number(),
        gone: z.number().describe("postings their boards no longer list (soft-deleted)"),
        expired: z.number(),
        feeds: z.record(z.number()),
        newBoards: z.array(z.string()),
        errors: z.array(z.string()),
        errorCount: z.number(),
        ranked: z.boolean(),
        matches: z.number(),
        activePostings: z.number(),
        seconds: z.number(),
      },
      annotations: { title: "Sync job sources", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args, extra) =>
      guard(() =>
        ctx.withRepo(async (repo) => {
          const started = Date.now();
          const token = extra._meta?.progressToken;
          let n = 0;
          const log = (line: string) => {
            n++;
            if (token === undefined) return;
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: line.replace(/\s+/g, " ").slice(0, 160) } })
              .catch(() => {});
          };
          const sync =
            opts.sync ??
            ((r: Repository, o: { full: boolean; log: (l: string) => void }) =>
              pollAll(
                r,
                o.full
                  ? { embedder: corpusEmbedder(), log: o.log }
                  : { embedder: corpusEmbedder(), limitPerCompany: 50, maxBoards: 25, skipSlowFeeds: true, telegramChannels: [], log: o.log },
              ));
          const stats = await sync(repo, { full: args.full, log });
          log("ranking against the profile");
          const ranked = await rankTenant(repo, tenantId);
          const matches = ranked ? (await repo.listMatches(tenantId, 1000)).length : 0;
          const active = (await repo.listActivePostings()).length;
          const seconds = Math.round((Date.now() - started) / 1000);
          const feeds = Object.entries(stats.feeds).filter(([, k]) => k > 0);
          const lines = [
            `Polled ${stats.companiesPolled} board(s) + ${Object.keys(stats.feeds).length} feed(s) in ${seconds}s: ${stats.fetched} postings fetched, ${stats.staled} gone, ${stats.expired} expired.`,
            feeds.length ? `Feeds: ${feeds.map(([k, v]) => `${k} ${v}`).join(", ")}` : null,
            `Corpus: ${active} active postings${ranked ? ` · ${matches} ranked for the user` : " · not ranked (no profile yet)"}.`,
            stats.errors.length ? `${stats.errors.length} source error(s), e.g. ${stats.errors.slice(0, 2).map((x) => redactSecrets(x)).join("; ")}` : null,
            stats.fetched === 0 ? "Nothing was fetched — if online, a proxy or firewall may be blocking job boards (`jobflow doctor` checks)." : "Next: list_jobs.",
          ].filter(Boolean);
          return ok(lines.join("\n"), {
            boardsPolled: stats.companiesPolled,
            fetched: stats.fetched,
            gone: stats.staled,
            expired: stats.expired,
            feeds: stats.feeds,
            newBoards: stats.resolved.slice(0, 50),
            errors: stats.errors.map((x) => redactSecrets(x)).slice(0, 20),
            errorCount: stats.errors.length,
            ranked,
            matches,
            activePostings: active,
            seconds,
          });
        }),
      ),
  );

  // ── resources ──
  server.registerResource(
    "profile",
    "jobflow://profile",
    {
      title: "The user's JobFlow profile",
      description:
        "SENSITIVE personal data: the user's own profile — contact details, résumé text, preferences (markets, salary floor, remote/relocation) and Evidence Bank. Stays on this machine; only use it for the user's own job search and don't send it anywhere they haven't asked for.",
      mimeType: "application/json",
    },
    async (uri) =>
      ctx.withRepo(async (repo) => {
        const [profile, evidence] = await Promise.all([loadProfile(repo, tenantId), repo.listEvidence(tenantId)]);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(profileOut(profile, evidence), null, 2) }] };
      }),
  );

  server.registerResource(
    "job",
    new ResourceTemplate("jobflow://job/{id}", {
      list: async () => {
        try {
          return await ctx.withRepo(async (repo) => {
            const data = await getFeed(repo, tenantId, { limit: 20, bootstrap: false });
            return {
              resources: data.cards.map((c: FeedCard) => ({
                uri: `jobflow://job/${c.id}`,
                name: `${c.title} · ${c.company}`,
                mimeType: "application/json",
                description: `${data.stats.mode === "ranked" ? `score ${c.score} · ` : ""}${c.location.label || c.location.mode}${c.comp ? ` · ${payText({ label: c.comp.label, kind: c.comp.estimate ? "estimate" : "stated", confidence: c.comp.confidence, confidenceScore: c.comp.confidenceScore, basis: c.comp.basis })}` : ""}`,
              })),
            };
          });
        } catch {
          return { resources: [] };
        }
      },
    }),
    {
      title: "A job posting",
      description: "One posting in full (same content as get_job): description, requirements, fit breakdown, flags, pay, freshness, tracker status, drafts, apply checklist.",
      mimeType: "application/json",
    },
    async (uri, vars) =>
      ctx.withRepo(async (repo) => {
        const id = Array.isArray(vars.id) ? vars.id[0]! : String(vars.id);
        const d = await jobDetail(repo, ctx, transient, decodeURIComponent(id), 20_000);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(plain(d), null, 2) }] };
      }),
  );

  registerPrompts(server, ctx, transient);
  return server;
}
