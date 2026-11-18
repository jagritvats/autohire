import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { InMemoryRepository } from "@jobflow/db";
import { normCompany, normalizePosting, type RawPosting } from "@jobflow/core";
import { toNewPosting } from "@jobflow/pipeline";
import { buildProgram } from "../src/program.js";
import { fakeFetch, run, tempDir, writeResume } from "./helpers.js";

const embed = Object.assign(async () => [1, 0, 0], { id: "test" });

async function seedPosting(repo: InMemoryRepository, n: number, title: string, companyName = `Acme ${n}`) {
  const slug = companyName.toLowerCase().replace(/\W+/g, "-");
  const company = await repo.upsertCompany({ name: companyName, nameNorm: normCompany(companyName), atsType: "greenhouse", atsSlug: slug });
  const raw: RawPosting = {
    source: "greenhouse",
    tier: "tier1",
    atsType: "greenhouse",
    atsJobId: String(4000 + n),
    companyName: company.name,
    companySlug: slug,
    title,
    jdText: `${title}: Java, Kafka, Postgres, distributed systems (team ${n}). Remote worldwide.`,
    jdHtml: null,
    locationRaw: "Remote",
    applyUrl: `https://boards.greenhouse.io/${slug}/jobs/${4000 + n}`,
    salaryRaw: null,
    postedAt: new Date(),
    fetchedAt: new Date(),
    raw: {},
  };
  return repo.upsertPosting(await toNewPosting(normalizePosting(raw), company.id, company.name, embed));
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // generation must run on the offline echo provider in tests, whatever the shell has
  for (const k of ["LLM_PROVIDER", "JOBFLOW_DATA_DIR", "JOBFLOW_BROWSER", "JOBFLOW_BROWSER_MODE"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

let tmp: ReturnType<typeof tempDir>;
let repo: InMemoryRepository;
beforeEach(() => {
  tmp = tempDir();
  repo = new InMemoryRepository();
  vi.stubGlobal("fetch", fakeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  tmp.cleanup();
});
const cli = (args: string[], stdin?: string) => run(args, { dataDir: tmp.dir, repo, stdin });

describe("jobflow init + profile", () => {
  it("init --yes with a résumé file → profile show --json reflects it", async () => {
    const resume = writeResume(tmp.dir);
    const r = await cli([
      "init", "--yes", "--resume", resume, "--home", "US", "--markets", "US,CA", "--remote", "worldwide,us_only",
      "--floor", "150000 USD", "--roles", "backend,platform", "--preset", "us",
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("next: jobflow sync && jobflow feed");

    const show = await cli(["--json", "profile", "show"]);
    expect(show.code).toBe(0);
    const p = show.json().profile;
    expect(p.prefs.contact.firstName).toBe("Sam");
    expect(p.prefs.contact.lastName).toBe("Placeholder");
    expect(p.prefs.contact.email).toBe("sam@example.com");
    expect(p.prefs.homeCountry).toBe("US");
    expect(p.prefs.markets).toEqual(["US", "CA"]);
    expect(p.prefs.remoteGeoOk).toEqual(["worldwide", "us_only"]);
    expect(p.prefs.salaryFloor).toBe(150000);
    expect(p.prefs.currency).toBe("USD");
    expect(p.prefs.targetArchetypes).toEqual(["backend", "platform"]);
    expect(p.prefs.stackProfile).toEqual(expect.arrayContaining(["go", "postgres", "kafka"]));
    expect(p.onboardedAt).not.toBeNull();
    expect(show.json().evidenceCount).toBeGreaterThan(0);

    const preset = await cli(["--json", "config", "get", "discovery.preset"]);
    expect(preset.json().value).toBe("us");
  });

  it("interactive init reads answers line by line (Enter keeps the suggested value)", async () => {
    const resume = writeResume(tmp.dir);
    const answers = [
      resume, // résumé path
      "", // name [Sam Placeholder]
      "", // email [sam@example.com]
      "", // phone
      "", // linkedin
      "", // github
      "go, postgres, kafka", // skills
      "5", // years
      "senior", // level
      "US", // home
      "US,CA", // markets
      "", // remote geos [suggested for US]
      "n", // relocate
      "150000 USD", // floor
      "backend", // roles
      "Remote, Austin", // locations
      "", // preset [suggested: us]
    ].join("\n");
    const r = await cli(["init"], answers + "\n");
    expect(r.code, r.err).toBe(0);
    const p = (await cli(["--json", "me"])).json().profile;
    expect(p.prefs.contact.email).toBe("sam@example.com");
    expect(p.yoe).toBe(5);
    expect(p.levelBand).toBe("senior");
    expect(p.prefs.stackProfile).toEqual(["go", "postgres", "kafka"]);
    expect(p.prefs.remoteGeoOk).toEqual(["us_only", "us_eu", "worldwide"]);
    expect(p.prefs.locationWeights.map((l: { label: string }) => l.label)).toEqual(["remote", "austin"]);
    expect((await cli(["--json", "config", "get", "discovery.preset"])).json().value).toBe("us");
  });

  it("profile set: the everyday fields, validated", async () => {
    await cli(["init", "--yes", "--sample"]);
    expect((await cli(["profile", "set", "email", "sam@example.com"])).code).toBe(0);
    expect((await cli(["profile", "set", "skills", "go,PostgreSQL,kafka"])).code).toBe(0);
    expect((await cli(["profile", "set", "home", "us"])).code).toBe(0);
    expect((await cli(["profile", "set", "name", "Sam", "Placeholder"])).code).toBe(0);
    expect((await cli(["profile", "set", "floor", "120k USD"])).code).toBe(0);
    expect((await cli(["profile", "set", "skills", "+rust"])).code).toBe(0);
    const p = (await cli(["--json", "me"])).json().profile;
    expect(p.prefs.contact.email).toBe("sam@example.com");
    expect(p.prefs.contact.firstName).toBe("Sam");
    expect(p.prefs.stackProfile).toEqual(["go", "postgres", "kafka", "rust"]);
    expect(p.prefs.homeCountry).toBe("US");
    expect(p.prefs.salaryFloor).toBe(120000);

    expect((await cli(["profile", "set", "nonsense", "x"])).code).toBe(2);
    expect((await cli(["profile", "set", "home", "USA"])).code).toBe(2);
    expect((await cli(["profile", "set", "level", "wizard"])).code).toBe(2);
  });

  it("persists across two program instances on a PGlite data dir", async () => {
    const dir = tempDir("jobflow-pglite-");
    try {
      const a = await run(["init", "--yes", "--sample"], { dataDir: dir.dir, store: "pglite" });
      expect(a.code, a.err).toBe(0);
      const b = await run(["profile", "set", "email", "sam@example.com"], { dataDir: dir.dir, store: "pglite" });
      expect(b.code, b.err).toBe(0);
      const c = await run(["--json", "me"], { dataDir: dir.dir, store: "pglite" });
      expect(c.code, c.err).toBe(0);
      expect(c.json().profile.prefs.contact.firstName).toBe("Alex");
      expect(c.json().profile.prefs.contact.email).toBe("sam@example.com");
      expect(c.json().evidenceCount).toBe(4);
    } finally {
      dir.cleanup();
    }
  }, 90_000);

  it("commands that need a profile exit 4 before init", async () => {
    const p = await seedPosting(repo, 1, "Backend Engineer");
    const r = await cli(["tailor", p.id]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("jobflow init");
  });
});

describe("evidence + config", () => {
  it("evidence add / list / rm", async () => {
    const add = await cli(["--json", "evidence", "add", "--project", "Example Corp", "--headline", "Built a Go ingestion service", "--detail", "10k events/s on Postgres + Kafka", "--metric", "10k events/s", "--tags", "go,kafka"]);
    expect(add.code, add.err).toBe(0);
    expect((await cli(["--json", "evidence", "list"])).json()).toHaveLength(1);
    expect((await cli(["evidence", "rm", "1"])).code).toBe(0);
    expect((await cli(["--json", "evidence"])).json()).toHaveLength(0);
    expect((await cli(["evidence", "rm", "1"])).code).toBe(3);
  });

  it("config set llm.key --stdin is stored but only ever shown masked", async () => {
    const secret = "sk-test-1234567890abcdef";
    const set = await cli(["config", "set", "llm.key", "--stdin"], `${secret}\n`);
    expect(set.code, set.err).toBe(0);
    expect(set.out + set.err).not.toContain(secret);
    const get = await cli(["config", "get", "llm.key"]);
    expect(get.out.trim()).toBe("••••cdef");
    const list = await cli(["--json", "config", "list"]);
    expect(list.out).not.toContain(secret);
    expect(list.json().settings["llm.key"]).toBe("••••cdef");
    // it is really stored
    expect((await repo.getConfig("00000000-0000-0000-0000-000000000001"))?.llmApiKey).toBe(secret);
    expect((await cli(["config", "set", "llm.provider", "not-a-provider"])).code).toBe(2);
    expect((await cli(["config", "get", "nope"])).code).toBe(2);
  });
});

describe("saved searches", () => {
  it("add / list / rm", async () => {
    const add = await cli(["searches", "add", "go-remote", "golang", "backend", "--remote", "--seniority", "senior"]);
    expect(add.code, add.err).toBe(0);
    const list = (await cli(["--json", "searches", "list"])).json();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("go-remote");
    expect(list[0].query.keywords).toEqual(["golang backend"]);
    expect(list[0].query.remote).toBe("only");
    expect(list[0].query.seniority).toEqual(["senior"]);
    expect((await cli(["searches", "rm", "go-remote"])).code).toBe(0);
    expect((await cli(["--json", "searches"])).json()).toHaveLength(0);
    expect((await cli(["searches", "rm", "go-remote"])).code).toBe(3);
  });
});

describe("feed, posting refs, search, apply, tailor", () => {
  it("feed numbers its rows; show accepts #N, N, an id and an id prefix", async () => {
    await cli(["init", "--yes", "--sample"]);
    const a = await seedPosting(repo, 1, "Backend Engineer");
    await seedPosting(repo, 2, "Platform Engineer");
    expect((await cli(["rank"])).code).toBe(0);
    const feed = await cli(["--json", "feed"]);
    expect(feed.code, feed.err).toBe(0);
    const cards = feed.json().cards;
    expect(cards.length).toBe(2);

    const byHash = (await cli(["--json", "show", "#1"])).json();
    expect(byHash.posting.id).toBe(cards[0].id);
    expect((await cli(["--json", "show", "2"])).json().posting.id).toBe(cards[1].id);
    expect((await cli(["--json", "show", a.id])).json().posting.id).toBe(a.id);
    expect((await cli(["--json", "show", a.id.slice(0, 8)])).json().posting.id).toBe(a.id);
    expect((await cli(["show", "#9"])).code).toBe(3);
    expect((await cli(["show", "zzzz"])).code).toBe(2);
  });

  it("search (network stubbed) ranks live results; apply on a row keeps it and prints a dry run", async () => {
    await cli(["init", "--yes", "--sample"]);
    const s = await cli(["--json", "search", "backend engineer", "--remote", "--sources", "remotive"]);
    expect(s.code, s.err).toBe(0);
    const res = s.json();
    expect(res.fetched).toBe(2);
    expect(res.cards.length).toBeGreaterThan(0);
    expect(res.cards[0].score).toBeGreaterThan(0);
    expect(res.postings).toBeUndefined();
    expect(await repo.listActivePostings()).toHaveLength(0); // a search writes nothing by default

    const human = await cli(["apply", "1"]);
    expect(human.code, human.err).toBe(0);
    expect(human.out).toContain("DRY RUN");
    expect(human.out).toContain("never submits");
    expect(human.out).toContain("alex@example.com");
    expect(await repo.listActivePostings()).toHaveLength(1); // the picked result was kept

    const j = (await cli(["--json", "apply", "1"])).json();
    expect(j.submitted).toBe(false);
    // the fictional sample has no résumé FILE to attach → not "ready" yet: "drafting", with the fix as next step
    expect(j.missing).toContain("resume");
    expect(j.tracker).toBe("drafting");
    expect(j.plan.fields.map((f: { field: string }) => f.field)).toContain("email");

    const track = (await cli(["--json", "track", "list"])).json();
    expect(track).toHaveLength(1);
    expect(track[0].status).toBe("drafting");
    expect(track[0].nextAction).toMatch(/^fix: .*resume/);
    expect((await cli(["track", "status", "1", "applied"])).code).toBe(0);
    expect((await cli(["--json", "track"])).json()[0].status).toBe("applied");
  });

  it("search --save-as saves the query; --ingest adds results to the corpus", async () => {
    await cli(["init", "--yes", "--sample"]);
    const s = await cli(["search", "backend", "--sources", "remotive", "--ingest", "--save-as", "be"]);
    expect(s.code, s.err).toBe(0);
    expect((await repo.listActivePostings()).length).toBe(2);
    expect((await cli(["--json", "searches"])).json()[0].name).toBe("be");
  });

  it("tailor with the echo provider: résumés are builtin, prose exits 4 with how to set a model", async () => {
    await cli(["init", "--yes", "--sample"]);
    const p = await seedPosting(repo, 1, "Backend Engineer");
    const resume = await cli(["--json", "tailor", p.id, "--kind", "resume"]);
    expect(resume.code, resume.err).toBe(0);
    expect(resume.json().source).toBe("builtin");
    expect(resume.json().variants.yc_startup.length).toBeGreaterThan(0);

    const md = await cli(["--json", "tailor", p.id, "--kind", "resume-md"]);
    expect(md.code, md.err).toBe(0);
    expect(md.json().source).toBe("builtin");

    const cover = await cli(["tailor", p.id, "--kind", "cover"]);
    expect(cover.code).toBe(4);
    expect(cover.err).toContain("jobflow config set llm.provider");
    expect((await cli(["tailor", p.id, "--kind", "answer"])).code).toBe(2);
  });
});

describe("discovery presets: multi-select, and usable as tags", () => {
  it("discovery use a,b switches on exactly those; preset-on/off toggles one", async () => {
    const use = await cli(["discovery", "use", "india,global-remote"]);
    expect(use.code, use.err).toBe(0);
    const on = (rows: Array<{ id: string; active: boolean }>) => rows.filter((p) => p.active).map((p) => p.id).sort();
    expect(on((await cli(["--json", "discovery", "presets"])).json())).toEqual(["global-remote", "india"]);
    expect((await cli(["discovery", "preset-on", "us"])).code).toBe(0);
    expect((await cli(["discovery", "preset-off", "india"])).code).toBe(0);
    expect(on((await cli(["--json", "discovery", "presets"])).json())).toEqual(["global-remote", "us"]);
    expect((await cli(["--json", "config", "get", "discovery.presets"])).json().value).toBe("global-remote,us");
    expect((await cli(["discovery", "use", "atlantis"])).code).toBe(2);
  });

  it("init --preset takes several", async () => {
    const r = await cli(["init", "--yes", "--sample", "--preset", "us,eu-uk"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("discovery: us, eu-uk");
  });

  it("search --preset / --tag reaches the query (and unknown presets are a usage error)", async () => {
    await cli(["init", "--yes", "--sample"]);
    const s = await cli(["--json", "search", "backend", "--preset", "us,eu-uk", "--sources", "remotive"]);
    expect(s.code, s.err).toBe(0);
    expect(s.json().query.presets).toEqual(["us", "eu-uk"]);
    const t = await cli(["--json", "search", "backend", "--tag", "india", "--sources", "remotive"]);
    expect(t.code, t.err).toBe(0);
    expect(t.json().query.presets).toEqual(["india"]);
    expect((await cli(["search", "backend", "--preset", "mars"])).code).toBe(2);
    expect((await cli(["feed", "--preset", "mars"])).code).toBe(2);
    expect((await cli(["--json", "feed", "--preset", "india"])).code).toBe(0);
  });
});

describe("the never-submit guarantee (invariant #2)", () => {
  it("no command, alias or option anywhere in the tree mentions submit", () => {
    const { program } = buildProgram();
    const hits: string[] = [];
    const walk = (cmd: Command, path: string) => {
      for (const n of [cmd.name(), ...cmd.aliases()]) if (/submit/i.test(n)) hits.push(`${path} (command ${n})`);
      for (const o of cmd.options) {
        if (/submit/i.test(o.flags) || /submit/i.test(o.long ?? "") || /submit/i.test(o.attributeName())) hits.push(`${path} ${o.flags}`);
      }
      for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
    };
    walk(program, "jobflow");
    expect(hits).toEqual([]);
    // and the walk really covered the tree
    expect(program.commands.map((c) => c.name())).toEqual(expect.arrayContaining(["apply", "search", "tailor", "track"]));
  });
});

describe("exit codes", () => {
  it("usage errors exit 2, unknown command exits 2, help exits 0", async () => {
    expect((await cli(["no-such-command"])).code).toBe(2);
    expect((await cli(["search"])).code).toBe(2);
    expect((await cli(["search", "x", "--posted", "soon"])).code).toBe(2);
    expect((await cli(["--help"])).code).toBe(0);
    expect((await cli(["apply", "--help"])).code).toBe(0);
  });

  it("an empty corpus says how to fill it", async () => {
    const r = await cli(["feed"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("corpus is empty");
    expect(r.err).toContain("jobflow sync");
  });
});
