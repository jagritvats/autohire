import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNeverSubmits, readFlags } from "../src/flags.js";

/**
 * Invariant #2: the form-filler never submits. These pin the gate so a refactor can't
 * quietly turn it into a setting.
 */
describe("never submits (invariant #2)", () => {
  it("autosubmit is hard-false whatever the env says", () => {
    const flags = readFlags({ JOBFLOW_AUTOSUBMIT: "true", JOBFLOW_BROWSER: "on", JOBFLOW_BROWSER_MODE: "fill" });
    expect(flags.autosubmit).toBe(false);
  });

  it("assertNeverSubmits refuses if autosubmit is somehow true", () => {
    expect(() => assertNeverSubmits({ ...readFlags({}), autosubmit: true })).toThrow(/Refusing to autosubmit/);
  });

  it("no source file clicks or triggers a submit", () => {
    const dir = join(__dirname, "../src");
    // a click/press/requestSubmit aimed at a submit control, or a form.submit() call
    const SUBMIT_ACTION = /(click|press|tap|dispatchEvent)\([^)]*submit|requestSubmit\(|\.submit\(\)/i;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(SUBMIT_ACTION.test(src), `${f} looks like it submits a form`).toBe(false);
    }
  });
});
