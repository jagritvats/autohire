import { afterEach, describe, expect, it } from "vitest";
import { browserCheck, playwrightStatus } from "../src/browser.js";
import { run, tempDir } from "./helpers.js";

/** Is Playwright resolvable here? (an optional peer dep — CI may not have it) */
const hasPlaywright = (await playwrightStatus({})).installed;

// any file that exists stands in for an installed Chrome binary
const EXISTING = process.execPath;
const MISSING = "/nonexistent/jobflow-test/chrome";

describe("JOBFLOW_CHROMIUM (apply --fill / doctor readiness)", () => {
  const prev = process.env.JOBFLOW_CHROMIUM;
  afterEach(() => {
    if (prev === undefined) delete process.env.JOBFLOW_CHROMIUM;
    else process.env.JOBFLOW_CHROMIUM = prev;
  });

  it.runIf(hasPlaywright)("an existing JOBFLOW_CHROMIUM counts as the browser, without Playwright's own Chromium", async () => {
    const pw = await playwrightStatus({ JOBFLOW_CHROMIUM: `  ${EXISTING}  ` });
    expect(pw).toMatchObject({ installed: true, chromium: true, executable: EXISTING, browserSource: "JOBFLOW_CHROMIUM" });
    expect(browserCheck(pw)).toMatchObject({ ok: true });
    expect(browserCheck(pw).detail).toContain("JOBFLOW_CHROMIUM");
  });

  it.runIf(hasPlaywright)("a JOBFLOW_CHROMIUM that names no file is reported, not silently replaced", async () => {
    const pw = await playwrightStatus({ JOBFLOW_CHROMIUM: MISSING });
    expect(pw).toMatchObject({ installed: true, chromium: false, customMissing: MISSING });
    const c = browserCheck(pw);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(MISSING);
  });

  it.runIf(hasPlaywright)("blank JOBFLOW_CHROMIUM means unset (Playwright's Chromium decides)", async () => {
    const pw = await playwrightStatus({ JOBFLOW_CHROMIUM: "  " });
    expect(pw.customMissing).toBeUndefined();
    expect(pw.browserSource === null || pw.browserSource === "playwright").toBe(true);
  });

  it("browserCheck names the fix for each state", () => {
    const base = { version: "1.0.0", executable: null, browserSource: null } as const;
    expect(browserCheck({ ...base, installed: false, version: null, chromium: false }).fix).toMatch(/playwright/);
    expect(browserCheck({ ...base, installed: true, chromium: false }).fix).toMatch(/JOBFLOW_CHROMIUM/);
    expect(browserCheck({ ...base, installed: true, chromium: true, browserSource: "playwright" }).ok).toBe(true);
  });

  it.runIf(hasPlaywright)("doctor accepts JOBFLOW_CHROMIUM", async () => {
    const t = tempDir();
    try {
      process.env.JOBFLOW_CHROMIUM = EXISTING;
      const r = await run(["doctor", "--offline", "--json"], { dataDir: t.dir });
      const checks = r.json<{ checks: Array<{ name: string; status: string; detail: string }> }>().checks;
      const pw = checks.find((c) => c.name === "playwright");
      expect(pw).toMatchObject({ status: "ok" });
      expect(pw?.detail).toContain("JOBFLOW_CHROMIUM");
    } finally {
      t.cleanup();
    }
  });
});
