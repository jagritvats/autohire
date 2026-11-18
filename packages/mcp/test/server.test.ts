import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryRepository, type Repository } from "@jobflow/db";
import { normCompany, normalizePosting, type Posting, type RawPosting } from "@jobflow/core";
import { HONEST_VOICE } from "@jobflow/llm";
import { sampleEvidence, toNewPosting, type PollStats } from "@jobflow/pipeline";
import type { SourceAdapter } from "@jobflow/adapters";
import { defaultConfig, loadSampleProfile, rankTenant } from "@jobflow/service";
import { createJobflowMcpServer, createLocalStore, sharedRepo, type JobflowMcpOptions, type RepoAccess } from "../src/index.js";

/**
 * The MCP server end to end over the SDK's in-memory transport (a real Client ↔ Server
 * pair), against an in-memory repo with the FICTIONAL sample persona and invented
 * postings. No live HTTP: search uses an injected fake adapter, sync an injected poller.
 */

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });
const SECRET = "sk-ant-test-supersecret-0123456789";

interface Fixture {
  repo: InMemoryRepository;
  tenantId: string;
  client: Client;
  postings: Posting[];
}

const JOBS: Array<{ company: string; title: string; loc: string; jd: string; salary?: string; feed?: "cutshort" }> = [
  { feed: "cutshort", company: "Acme Pay", title: "Backend Engineer, Ledger", loc: "Bengaluru, India", jd: "Backend engineer for our ledger: Java, Kafka, PostgreSQL, idempotent APIs, distributed systems. 2-5 years of experience.", salary: "₹30L – ₹45L per annum" },
  { company: "Globex Cloud", title: "Platform Engineer", loc: "Remote (Worldwide)", jd: "Internal developer platform: Kubernetes, Terraform, Go, CI/CD. 3+ years experience. Remote worldwide." },
  { company: "Umbrella Data", title: "Senior Data Engineer", loc: "Remote (US only)", jd: "Senior data engineer: Spark, Airflow, Python, Snowflake. 6+ years. Must be located in the United States.", salary: "$170,000 – $210,000" },
  { feed: "cutshort", company: "Stark Fintech", title: "Backend Engineer (Kafka)", loc: "Pune, India", jd: "Real-time risk engine on Kafka Streams and Java/Spring. PostgreSQL, Redis, Docker. 1-3 years of experience." },
];

async function seed(repo: InMemoryRepository): Promise<Posting[]> {
  const out: Posting[] = [];
  for (const [i, j] of JOBS.entries()) {
    const slug = normCompany(j.company).replace(/\W+/g, "");
    // two Indian roles via an India-only feed (tagged #india), two straight from Lever boards
    const ats = j.feed ? "unknown" : "lever";
    const company = await repo.upsertCompany({ name: j.company, nameNorm: normCompany(j.company), atsType: ats, atsSlug: slug });
    await repo.touchPolled(company.id);
    const raw: RawPosting = {
      source: j.feed ?? "lever", tier: j.feed ? "tier2" : "tier1", atsType: ats, atsJobId: `mcp-${i + 1}`, companyName: j.company, companySlug: slug,
      title: j.title, jdText: j.jd, jdHtml: null, locationRaw: j.loc, applyUrl: `https://jobs.lever.co/${slug}/mcp-${i + 1}`,
      salaryRaw: j.salary ?? null, postedAt: new Date(Date.now() - (i + 1) * 86_400_000), fetchedAt: new Date(), raw: {},
    };
    out.push(await repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embed)));
  }
  return out;
}

async function connect(access: Pick<RepoAccess, "withRepo">, tenantId: string, opts: JobflowMcpOptions = {}): Promise<Client> {
  const server = createJobflowMcpServer({ tenantId, withRepo: (fn) => access.withRepo(fn), files: null, store: "memory" }, opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "jobflow-test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function fixture(opts: JobflowMcpOptions & { sample?: boolean } = {}): Promise<Fixture> {
  const repo = new InMemoryRepository();
  const t = await repo.createTenant({ name: "t" });
  await repo.saveConfig({ ...defaultConfig(t.id), llmChoice: "echo", llmApiKey: SECRET });
  if (opts.sample !== false) await loadSampleProfile(repo, t.id);
  const postings = await seed(repo);
  await rankTenant(repo, t.id);
  const client = await connect(sharedRepo(repo, t.id), t.id, opts);
  return { repo, tenantId: t.id, client, postings };
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}
const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // generation must run on the offline echo provider, whatever the shell has
  for (const k of ["LLM_PROVIDER", "JOBFLOW_DATA_DIR", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

describe("tools, prompts and resources are listed with valid schemas", () => {
  it("every tool has an object input schema, an output schema and truthful annotations", async () => {
    const { client } = await fixture();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "draft_document",
        "get_job",
        "jobflow_status",
        "list_applications",
        "list_jobs",
        "list_saved_searches",
        "prepare_application",
        "run_saved_search",
        "save_search",
        "search_jobs",
        "sync_sources",
        "track_application",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.outputSchema?.type, t.name).toBe("object");
      expect(t.description?.length, t.name).toBeGreaterThan(40);
      expect(t.annotations, t.name).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.openWorldHint, t.name).toBe("boolean");
    }
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations!]));
    for (const n of ["jobflow_status", "list_jobs", "get_job", "list_saved_searches", "list_applications"]) expect(ann[n]!.readOnlyHint, n).toBe(true);
    for (const n of ["track_application", "save_search", "sync_sources", "draft_document", "prepare_application"]) expect(ann[n]!.readOnlyHint, n).toBe(false);
    for (const n of ["search_jobs", "sync_sources", "run_saved_search"]) expect(ann[n]!.openWorldHint, n).toBe(true);
    expect(ann.list_jobs!.openWorldHint).toBe(false);

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["tailor_application", "triage_jobs"]);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("jobflow://profile");
    expect(resources.some((r) => r.uri.startsWith("jobflow://job/"))).toBe(true);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toEqual(["jobflow://job/{id}"]);
  });

  it("no tool can submit or auto-apply (invariant #2) — only 'never submits' wording mentions it", async () => {
    const { client } = await fixture();
    const { tools } = await client.listTools();
    const NEGATED = /\b(never|does not|doesn't|cannot|can't|won't)\s+(submits?|auto[- ]?appl(y|ies))\b/gi;
    for (const t of tools) {
      const surface = JSON.stringify({ name: t.name, title: t.title, description: t.description, input: t.inputSchema, output: t.outputSchema, annotations: t.annotations });
      const rest = surface.replace(NEGATED, "");
      expect(rest, `${t.name} mentions submitting outside "never submits" wording`).not.toMatch(/submit|auto[- ]?apply/i);
    }
    // and no source file in this package reaches the browser filler
    const dir = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/fillPlanOnPage|launchUserContext|@jobflow\/autofill|playwright/);
    }
  });
});

describe("jobflow_status", () => {
  it("reports setup progress and the next step — and never a secret", async () => {
    const { client } = await fixture();
    const r = await call(client, "jobflow_status");
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent;
    expect(s.profile.onboarded).toBe(true);
    expect(s.profile.name).toBe("Alex Example");
    expect(s.corpus.postings).toBe(4);
    expect(s.corpus.matches).toBeGreaterThan(0);
    expect(s.next.tool).toBe("save_search");
    expect(s.model).toEqual({ configured: false, provider: "echo" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("before onboarding: says jobs can't be scored yet", async () => {
    const { client } = await fixture({ sample: false });
    const r = await call(client, "jobflow_status");
    expect(r.structuredContent.profile.onboarded).toBe(false);
    expect(r.structuredContent.next.cli).toBe("jobflow init");
    expect(text(r)).toMatch(/can't be scored/);
  });
});

describe("list_jobs", () => {
  it("ranks the feed best first, with flags and labelled pay", async () => {
    const { client } = await fixture();
    const r = await call(client, "list_jobs", { limit: 10 });
    expect(r.isError).toBeFalsy();
    const { jobs, mode } = r.structuredContent;
    expect(mode).toBe("ranked");
    // the US-only remote role can't be worked from India (relocation off): the scorer's
    // impossible-location hard exclusion — one of only two — keeps it out of the feed
    expect(jobs.length).toBe(3);
    expect(jobs.map((j: { company: string }) => j.company)).not.toContain("Umbrella Data");
    const scores = jobs.map((j: { score: number }) => j.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const acme = jobs.find((j: { company: string }) => j.company === "Acme Pay");
    expect(acme.pay).toMatchObject({ kind: "stated" });
    expect(text(r)).toContain("Backend Engineer, Ledger");
  });

  it("a preset filter is a view: it hides with counts, never rescoring", async () => {
    const { client } = await fixture();
    const all = (await call(client, "list_jobs", {})).structuredContent.jobs as Array<{ id: string; score: number; presets: string[] }>;
    const r = await call(client, "list_jobs", { presets: ["india"] });
    const { jobs, hiddenTotal, hidden } = r.structuredContent;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.length).toBeLessThan(all.length);
    for (const j of jobs) expect(j.presets).toContain("india");
    expect(hiddenTotal).toBe(all.length - jobs.length);
    expect(Object.values(hidden as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(hiddenTotal);
    for (const j of jobs) expect(j.score).toBe(all.find((a) => a.id === j.id)!.score);
    expect(text(r)).toMatch(/hid \d+/);
  });

  it("an unknown preset is a tool error, not a crash", async () => {
    const { client } = await fixture();
    const r = await call(client, "list_jobs", { presets: ["atlantis"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/unknown preset/);
  });

  it("saved searches: save, list, and view the feed through one", async () => {
    const { client } = await fixture();
    const s = await call(client, "save_search", { name: "kafka", query: '"backend" --must kafka', runOnSync: false });
    expect(s.isError).toBeFalsy();
    expect(s.structuredContent.search.query).toContain("must: kafka");
    const l = await call(client, "list_saved_searches");
    expect(l.structuredContent.searches.map((x: { name: string }) => x.name)).toEqual(["kafka"]);
    const v = await call(client, "list_jobs", { savedSearch: "kafka" });
    expect(v.isError).toBeFalsy();
    expect(v.structuredContent.hiddenTotal).toBeGreaterThan(0);
    const missing = await call(client, "list_jobs", { savedSearch: "nope" });
    expect(missing.isError).toBe(true);
  });
});

describe("get_job", () => {
  it("resolves a unique id prefix and returns the full picture", async () => {
    const { client, postings } = await fixture();
    const p = postings[0]!;
    const r = await call(client, "get_job", { id: p.id.slice(0, 8), maxDescriptionChars: 200 });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d.job.id).toBe(p.id);
    expect(d.inCorpus).toBe(true);
    expect(d.requirements.must.length + d.requirements.nice.length).toBeGreaterThan(0);
    expect(d.fit.breakdown).toHaveProperty("stackAdjacency");
    expect(d.freshness.postedAt).toBeTruthy();
    expect(d.apply.missing.map((m: { gap: string }) => m.gap)).toContain("resume"); // the sample persona has no résumé file
    expect(d.descriptionTruncated).toBe(false);
    const short = await call(client, "get_job", { id: p.id, maxDescriptionChars: 200 });
    expect(short.structuredContent.descriptionChars).toBe(p.jdText.length);
  });

  it("bad ids are tool errors with a hint", async () => {
    const { client } = await fixture();
    const r1 = await call(client, "get_job", { id: "ffffffff" });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/No posting id starts with/);
    const r2 = await call(client, "get_job", { id: "not an id!" });
    expect(r2.isError).toBe(true);
    const r3 = await call(client, "get_job", {});
    expect(r3.isError).toBe(true);
  });
});

describe("tracker", () => {
  it("track_application adds and updates; list_applications shows it with the follow-up", async () => {
    const { client, postings, repo, tenantId } = await fixture();
    const p = postings[1]!;
    const a = await call(client, "track_application", { id: p.id });
    expect(a.structuredContent).toMatchObject({ created: true, application: { status: "saved", postingId: p.id } });
    const b = await call(client, "track_application", { id: p.id.slice(0, 6), status: "applied", nextAction: "follow up", due: "2026-12-01", note: "sent via careers page" });
    expect(b.structuredContent.created).toBe(false);
    expect(b.structuredContent.application).toMatchObject({ status: "applied", nextAction: "follow up", note: "sent via careers page" });
    expect(b.structuredContent.application.nextActionAt.slice(0, 10)).toBe("2026-12-01");
    expect(b.structuredContent.application.appliedAt).toBeTruthy();
    const l = await call(client, "list_applications");
    expect(l.structuredContent.applications).toHaveLength(1);
    expect(l.structuredContent.applications[0].title).toBe(p.title);
    expect((await repo.getApplicationByPosting(tenantId, p.id))?.status).toBe("applied");
    const bad = await call(client, "track_application", { id: p.id, status: "hired" });
    expect(bad.isError).toBe(true);
    const badDue = await call(client, "track_application", { id: p.id, due: "next tuesday" });
    expect(badDue.isError).toBe(true);
  });
});

describe("prepare_application", () => {
  it("returns the dry-run plan and the --fill command, and fills / changes nothing", async () => {
    const { client, postings, repo, tenantId } = await fixture();
    const p = postings[1]!;
    const r = await call(client, "prepare_application", { id: p.id });
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d.commands.fill).toBe(`jobflow apply ${p.id} --fill`);
    expect(d.applyUrl).toContain("lever.co");
    expect(d.fields.find((f: { field: string }) => f.field === "email")?.value).toBe("alex@example.com");
    expect(d.ready).toBe(false);
    expect(d.missing.map((m: { gap: string }) => m.gap)).toContain("resume");
    expect(d.dryRun).toMatch(/DRY RUN/);
    expect(text(r)).toMatch(/Nothing was opened, filled or sent/);
    expect(text(r)).toContain(`jobflow apply ${p.id} --fill`);
    // a dry run: the tracker is untouched
    expect(await repo.getApplicationByPosting(tenantId, p.id)).toBeNull();
  });
});

describe("draft_document", () => {
  it("offline (echo): a résumé comes back as the labelled builtin template", async () => {
    const { client, postings } = await fixture();
    const r = await call(client, "draft_document", { id: postings[0]!.id, kind: "resume_md" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.source).toBe("builtin");
    expect(r.structuredContent.text).toContain("Alex Example");
    expect(text(r)).toMatch(/builtin — a deterministic template/);
    const v = await call(client, "draft_document", { id: postings[0]!.id, kind: "resume" });
    expect(v.structuredContent.variants.startup.length).toBeGreaterThan(0);
  });

  it("offline (echo): prose refuses with a clear 'needs a model' error", async () => {
    const { client, postings } = await fixture();
    const r = await call(client, "draft_document", { id: postings[0]!.id, kind: "cover_letter" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/needs a generation model/);
    expect(text(r)).toMatch(/tailor_application/);
    const a = await call(client, "draft_document", { id: postings[0]!.id, kind: "answer" });
    expect(a.isError).toBe(true);
    expect(text(a)).toMatch(/needs the `question`/);
  });
});

describe("prompts", () => {
  it("tailor_application carries HONEST_VOICE, the candidate's evidence and the role", async () => {
    const { client, postings } = await fixture();
    const p = postings[0]!;
    const r = await client.getPrompt({ name: "tailor_application", arguments: { jobId: p.id, kind: "cover_letter" } });
    const body = r.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
    expect(body).toContain(HONEST_VOICE);
    expect(body).toContain(sampleEvidence()[0]!.headline);
    expect(body).toContain("never to extend it");
    expect(body).toContain(p.title);
    expect(body).toMatch(/Gaps/);
    expect(body).not.toContain(SECRET);
  });

  it("triage_jobs embeds the top jobs with their flags", async () => {
    const { client } = await fixture();
    const r = await client.getPrompt({ name: "triage_jobs", arguments: { count: "3" } });
    const body = r.messages.map((m) => (m.content.type === "text" ? m.content.text : "")).join("\n");
    expect(body).toMatch(/top 3 job/);
    expect(body).toMatch(/id: [0-9a-f-]{36}/);
  });
});

describe("resources", () => {
  it("jobflow://profile is the user's own profile and evidence, with no secrets; jobflow://job/{id} is the job", async () => {
    const { client, postings } = await fixture();
    const r = await client.readResource({ uri: "jobflow://profile" });
    const body = (r.contents[0] as { text: string }).text;
    const prof = JSON.parse(body);
    expect(prof.name).toBe("Alex Example");
    expect(prof.evidence.length).toBe(sampleEvidence().length);
    expect(body).not.toContain(SECRET);
    expect(body).not.toMatch(/llmApiKey|embedding/);
    const j = await client.readResource({ uri: `jobflow://job/${postings[2]!.id}` });
    expect(JSON.parse((j.contents[0] as { text: string }).text).job.title).toBe(postings[2]!.title);
  });
});

describe("search_jobs (fake adapter — no network)", () => {
  const fake: SourceAdapter = {
    source: "remotive",
    tier: "tier2",
    toTargets: () => [{ query: "backend" }],
    fetch: async () => [
      {
        source: "remotive", tier: "tier2", atsType: "unknown", atsJobId: "fake-1", companyName: "Initech Labs", companySlug: "initech",
        title: "Backend Engineer, Payments", jdText: "Payments platform: Java, Kafka, PostgreSQL, REST. 2-4 years. Remote worldwide.", jdHtml: null,
        locationRaw: "Remote (Worldwide)", applyUrl: "https://example.com/initech/apply", salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
      },
      {
        source: "remotive", tier: "tier2", atsType: "unknown", atsJobId: "fake-2", companyName: "Hooli", companySlug: "hooli",
        title: "Frontend Engineer", jdText: "React and CSS. Remote worldwide.", jdHtml: null,
        locationRaw: "Remote (Worldwide)", applyUrl: "https://example.com/hooli/apply", salaryRaw: null, postedAt: new Date(), fetchedAt: new Date(), raw: {},
      },
    ],
  };
  const tier3: SourceAdapter = { source: "linkedin", tier: "tier3", toTargets: () => [{ query: "x" }], fetch: async () => { throw new Error("a tier-3 adapter must never be asked"); } };

  it("scores live results against the profile, counts what the query hid, and writes nothing", async () => {
    const { client, repo } = await fixture({ adapters: [fake, tier3] });
    const before = (await repo.listActivePostings()).length;
    const r = await call(client, "search_jobs", { query: '"backend" --remote --must kafka', limit: 5 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent;
    expect(s.scored).toBe(true);
    expect(s.fetched).toBe(2);
    expect(s.sources).toEqual(["remotive"]);
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({ title: "Backend Engineer, Payments", inFeed: false });
    expect(typeof s.results[0].score).toBe("number");
    expect(s.hiddenTotal).toBe(1);
    expect((await repo.listActivePostings()).length).toBe(before);

    // a transient result: get_job reads it without saving; track_application keeps it
    const id = s.results[0].id as string;
    const g = await call(client, "get_job", { id });
    expect(g.structuredContent.inCorpus).toBe(false);
    expect((await repo.listActivePostings()).length).toBe(before);
    const t = await call(client, "track_application", { id });
    expect(t.structuredContent.keptFromSearch).toBe(true);
    expect((await repo.listActivePostings()).length).toBe(before + 1);
    const again = await call(client, "get_job", { id });
    expect(again.structuredContent.inCorpus).toBe(true);
  });

  it("structured fields work like the flag syntax; an empty query is a tool error", async () => {
    const { client } = await fixture({ adapters: [fake] });
    const r = await call(client, "search_jobs", { keywords: ["backend"], remote: "only", mustSkills: ["kafka"] });
    expect(r.structuredContent.query).toContain("must: kafka");
    expect(r.structuredContent.results).toHaveLength(1);
    const e = await call(client, "search_jobs", {});
    expect(e.isError).toBe(true);
    const bad = await call(client, "search_jobs", { query: "backend", sources: ["nosuchboard"] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/unknown source/);
  });
});

describe("sync_sources", () => {
  it("runs the (injected) poll, re-ranks, and reports", async () => {
    let polled = 0;
    const sync = async (repo: Repository, o: { full: boolean; log: (l: string) => void }): Promise<PollStats> => {
      polled++;
      o.log("polling lever: initech");
      expect(o.full).toBe(false);
      return { companiesPolled: 3, fetched: 12, staled: 1, feeds: { remotive: 5 }, resolved: [], expired: 0, errors: [] };
    };
    const { client } = await fixture({ sync });
    const r = await call(client, "sync_sources", {});
    expect(r.isError).toBeFalsy();
    expect(polled).toBe(1);
    expect(r.structuredContent).toMatchObject({ boardsPolled: 3, fetched: 12, gone: 1, ranked: true, activePostings: 4 });
  });
});

describe("the store: lazy, serialised, released when idle, friendly when busy", () => {
  it("a busy data dir is a tool error with the fix, not a crash", async () => {
    const access = createLocalStore({
      tenantId: "00000000-0000-0000-0000-000000000001",
      busyRetries: 1,
      busyRetryMs: 5,
      open: async () => {
        throw new Error("JobFlow data dir /tmp/x is in use by another process (pid 4242, since 2026-01-01). The local database is single-writer");
      },
    });
    const client = await connect(access, "00000000-0000-0000-0000-000000000001");
    const r = await call(client, "jobflow_status");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/single-writer/);
    expect(text(r)).toMatch(/stop the web app/);
    expect(text(r)).toMatch(/DATABASE_URL/);
    // the server is still alive
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
  });

  it("opens on first use and closes after the idle period", async () => {
    let opened = 0;
    let closed = 0;
    const open = async () => {
      opened++;
      const r = new InMemoryRepository() as InMemoryRepository & { close(): Promise<void> };
      r.close = async () => void closed++;
      return r;
    };
    const access = createLocalStore({ tenantId: "00000000-0000-0000-0000-000000000002", idleMs: 40, open });
    expect(access.isOpen).toBe(false);
    await Promise.all([access.withRepo(async () => 1), access.withRepo(async () => 2)]);
    expect(opened).toBe(1); // serialised, one open
    expect(access.isOpen).toBe(true);
    await new Promise((res) => setTimeout(res, 120));
    expect(access.isOpen).toBe(false);
    expect(closed).toBe(1);
    await access.withRepo(async () => 3);
    expect(opened).toBe(2);
    await access.close();
    expect(closed).toBe(2);
  });
});
