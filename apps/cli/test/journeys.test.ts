import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "@jobflow/db";
import { fakeFetch, run, tempDir } from "./helpers.js";

/** First-run journeys: status + next step, no empty profiles, no invented claims. */

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
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

describe("first run: status, next steps, and no invented scores", () => {
  it("bare `jobflow` shows where you are and ONE next step (not the full help)", async () => {
    const r = await cli([]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Getting started 0/4");
    expect(r.out).toContain("Next: add your résumé");
    expect(r.out).toContain("jobflow init");
    expect(r.out).not.toContain("Usage:");

    const j = (await cli(["--json", "status"])).json();
    expect(j.next.id).toBe("profile");
    expect(j.steps).toHaveLength(4);

    await cli(["init", "--yes", "--sample"]);
    const after = (await cli(["--json"])).json();
    expect(after.profile.onboarded).toBe(true);
    expect(after.next.id).toBe("sync");
  });

  it("init --yes with nothing to go on refuses instead of saving an empty profile", async () => {
    const r = await cli(["init", "--yes", "--home", "US"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--resume <file> or --skills <list>");
    expect((await cli(["--json", "status"])).json().profile.onboarded).toBe(false);
    // skills alone are enough to score against
    const ok = await cli(["init", "--yes", "--skills", "go,postgres", "--yoe", "4", "--home", "US"]);
    expect(ok.code, ok.err).toBe(0);
    expect((await cli(["--json", "status"])).json().profile.onboarded).toBe(true);
  });

  it("an unscored search (no profile yet) makes no claims about you and hides nothing", async () => {
    const s = await cli(["--json", "search", "backend engineer", "--sources", "remotive"]);
    expect(s.code, s.err).toBe(0);
    const res = s.json();
    expect(res.scored).toBe(false);
    expect(res.excluded).toBe(0);
    expect(res.cards.length).toBe(2);
    for (const c of res.cards) {
      expect(c.score).toBe(0);
      expect(c.stackNote).toBeNull();
      expect(c.levelNote).toBeNull();
      expect(c.redFlags).toEqual([]);
    }
    const human = await cli(["search", "backend engineer", "--sources", "remotive"]);
    expect(human.out).not.toMatch(/your stack|you're|hard-excluded/);
    expect(human.err).not.toMatch(/hard-excluded/);
  });

  it("show prints the apply checklist and the next commands", async () => {
    await cli(["init", "--yes", "--sample"]);
    await cli(["search", "backend engineer", "--sources", "remotive"]);
    const r = await cli(["show", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ready\?\s+not yet — missing resume/);
    expect(r.err).toContain("next: jobflow track add 1");
    expect((await cli(["--json", "show", "1"])).json().apply.missing).toContain("resume");
  });

  it("an empty tracker points at how to fill it", async () => {
    const r = await cli(["track"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing tracked yet.");
    expect(r.err).toContain("jobflow track add 1");
  });
});
