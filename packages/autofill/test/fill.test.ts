import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFillPlan,
  defaultProfileDir,
  fieldMapFor,
  fillPlanOnPage,
  greenhouseHostedUrl,
  readFlags,
  renderDryRun,
  resolveApplyUrl,
  resolveProfileDir,
  type PwLocator,
  type PwPage,
} from "../src/index.js";

const FLAGS = { ...readFlags({ JOBFLOW_BROWSER: "on", JOBFLOW_BROWSER_MODE: "fill", JOBFLOW_RATE: "fast" }) };
const APPLICANT = { firstName: "Alex", lastName: "Example", email: "alex@example.com", resumePath: "/tmp/resume.pdf" };

/**
 * A fake page whose DOM is a set of selectors, each visible or hidden. Every method the
 * runner calls is logged so the test can prove nothing but fill/setInputFiles happens.
 */
function fakePage(dom: Record<string, { visible: boolean }>) {
  const calls: string[] = [];
  const locator = (sel: string): PwLocator => {
    const el = dom[sel];
    const loc: PwLocator = {
      first: () => loc,
      count: async () => (el ? 1 : 0),
      isVisible: async () => !!el?.visible,
      fill: async (v) => void calls.push(`fill ${sel} ${v}`),
      setInputFiles: async (f) => void calls.push(`setInputFiles ${sel} ${f}`),
    };
    // any method beyond the structural type would be a submit vector — trap it
    return new Proxy(loc, {
      get(t, p) {
        if (!(p in t)) throw new Error(`runner called unexpected locator method ${String(p)}`);
        return t[p as keyof PwLocator];
      },
    });
  };
  const page: PwPage = {
    goto: async (u) => void calls.push(`goto ${u}`),
    url: () => "https://job-boards.greenhouse.io/acme/jobs/123",
    content: async () => "",
    close: async () => {},
    locator,
    evaluate: async () => {
      throw new Error("runner must not evaluate script in the page");
    },
  };
  return { page, calls };
}

describe("fillPlanOnPage", () => {
  it("attaches the résumé to a HIDDEN file input and never clicks or submits", async () => {
    const { page, calls } = fakePage({
      "#first_name": { visible: true },
      "#last_name": { visible: true },
      "#email": { visible: true },
      "input[type='file'][name*='resume']": { visible: false }, // styled-away input
    });
    const plan = buildFillPlan("greenhouse", "https://job-boards.greenhouse.io/acme/jobs/123", APPLICANT);
    const report = await fillPlanOnPage(page, plan, { flags: FLAGS });
    expect(report.filled).toContain("resume");
    expect(report.submitted).toBe(false);
    expect(calls).toContain("setInputFiles input[type='file'][name*='resume'] /tmp/resume.pdf");
    expect(calls.every((c) => /^(goto|fill|setInputFiles) /.test(c))).toBe(true);
  });

  it("refuses outright when autosubmit is somehow on", async () => {
    const { page, calls } = fakePage({});
    const plan = buildFillPlan("greenhouse", "https://x", APPLICANT);
    await expect(fillPlanOnPage(page, plan, { flags: { ...FLAGS, autosubmit: true } })).rejects.toThrow(/Refusing to autosubmit/);
    expect(calls).toHaveLength(0);
  });
});

describe("field maps", () => {
  it("unknown / aggregator / unmapped ATSes get the generic map, not Greenhouse's", () => {
    for (const ats of ["unknown", "smartrecruiters", "keka"] as const) {
      const m = fieldMapFor(ats);
      expect(m.firstName?.selectors).not.toContain("#first_name");
      expect(m.email?.selectors).toContain("input[type='email']");
      // conservative: no bare file-input fallback on unknown forms
      expect(m.resume?.selectors).not.toContain("input[type='file']");
    }
    expect(renderDryRun(buildFillPlan("unknown", "https://x", APPLICANT))).toContain("generic field map");
    expect(fieldMapFor("greenhouse").firstName?.selectors).toContain("#first_name");
  });
});

describe("Greenhouse apply URL", () => {
  it("opens the hosted form when the stored URL is the employer's own page", () => {
    expect(greenhouseHostedUrl("acme", "123")).toBe("https://job-boards.greenhouse.io/acme/jobs/123");
    expect(resolveApplyUrl("greenhouse", "https://acme.com/careers?gh_jid=123", { slug: "acme", jobId: "123" })).toBe(
      "https://job-boards.greenhouse.io/acme/jobs/123",
    );
    expect(resolveApplyUrl("greenhouse", null, { slug: "acme", jobId: "123" })).toBe("https://job-boards.greenhouse.io/acme/jobs/123");
  });

  it("keeps Greenhouse-hosted URLs, other ATSes, and anything without slug + numeric id", () => {
    const gh = "https://boards.greenhouse.io/acme/jobs/123";
    expect(resolveApplyUrl("greenhouse", gh, { slug: "acme", jobId: "123" })).toBe(gh);
    expect(resolveApplyUrl("lever", "https://acme.com/x", { slug: "acme", jobId: "123" })).toBe("https://acme.com/x");
    expect(resolveApplyUrl("greenhouse", "https://acme.com/x", { slug: null, jobId: "123" })).toBe("https://acme.com/x");
    expect(resolveApplyUrl("greenhouse", "https://acme.com/x", { slug: "acme", jobId: "gh:123" })).toBe("https://acme.com/x");
  });
});

describe("browser profile dir", () => {
  it("defaults under the home dir, not the cwd; blank env counts as unset", () => {
    const def = join(homedir(), ".jobflow", "browser-profile");
    expect(defaultProfileDir({})).toBe(def);
    expect(defaultProfileDir({ JOBFLOW_BROWSER_PROFILE: "  " })).toBe(def);
    expect(defaultProfileDir({ JOBFLOW_BROWSER_PROFILE: "~/prof" })).toBe(join(homedir(), "prof"));
    expect(resolveProfileDir("", { JOBFLOW_BROWSER_PROFILE: "/x" })).toBe("/x");
  });
});
