import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFillPlan, fillPlanOnPage, type AutomationFlags } from "../src/index.js";

/**
 * END-TO-END in a real Chromium: fill a Greenhouse-style application form served locally and
 * prove invariant #2 — every field is filled, the résumé is attached to the HIDDEN file input,
 * and the form is NEVER submitted (the server counts POSTs; the page never navigates away).
 *
 * Runs wherever Playwright + Chromium are installed; skipped otherwise (e.g. plain CI).
 * JOBFLOW_E2E_SCREENSHOT=/path.png saves a picture of the filled form at the review gate.
 */
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pw: any = null;
try {
  pw = require("playwright");
} catch {
  pw = null;
}
// a Chromium this Playwright can drive: its own download, else an explicit/system one
// (JOBFLOW_CHROMIUM, or a preinstalled build). Playwright without a browser → skip.
const executablePath: string | undefined = (() => {
  if (!pw) return undefined;
  try {
    if (existsSync(pw.chromium.executablePath())) return undefined; // the default works
  } catch {
    /* no default */
  }
  return [process.env.JOBFLOW_CHROMIUM, "/opt/pw-browsers/chromium"].find((p): p is string => !!p && existsSync(p));
})();
const canLaunch = !!pw && (executablePath !== undefined || (() => {
  try {
    return existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
})());

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Apply · Backend Engineer · Example Corp</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#1b1f24}
  h1{font-size:22px;margin:0 0 4px} p.sub{color:#57606a;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}
  input[type=text],input[type=email],input[type=tel],textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d0d7de;border-radius:6px;font-size:14px}
  .attach{display:inline-block;padding:7px 12px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;font-size:13px;cursor:pointer}
  #resume{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
  #resume-name{margin-left:8px;font-size:13px;color:#1a7f37}
  button{margin-top:24px;padding:10px 18px;border:0;border-radius:6px;background:#1f883d;color:#fff;font-size:14px}
</style></head><body>
<h1>Backend Engineer</h1><p class="sub">Example Corp · Remote</p>
<form id="application_form" method="post" action="/submit" enctype="multipart/form-data">
  <label for="first_name">First name</label><input type="text" id="first_name" name="first_name">
  <label for="last_name">Last name</label><input type="text" id="last_name" name="last_name">
  <label for="email">Email</label><input type="email" id="email" name="email">
  <label for="phone">Phone</label><input type="tel" id="phone" name="phone">
  <label>Résumé/CV</label><span class="attach" onclick="document.getElementById('resume').click()">Attach</span>
  <input type="file" id="resume" name="resume"><span id="resume-name"></span>
  <label for="linkedin">LinkedIn profile</label><input type="text" id="linkedin" name="job_application[linkedin]">
  <label for="cover_letter_text">Cover letter</label><textarea id="cover_letter_text" name="cover_letter" rows="5"></textarea>
  <button type="submit" id="submit_app">Submit application</button>
</form>
<script>document.getElementById('resume').addEventListener('change',e=>{document.getElementById('resume-name').textContent=e.target.files[0]?.name||''})</script>
</body></html>`;

describe.skipIf(!canLaunch)("autofill in a real browser (invariant #2: never submits)", () => {
  let server: Server;
  let url = "";
  let submissions = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST") submissions++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.method === "POST" ? "<h1>Application submitted</h1>" : FORM);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/apply`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fills every field + the hidden résumé input, then stops at review with zero submissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobflow-e2e-"));
    const resume = join(dir, "Sam_Placeholder_Resume.pdf");
    writeFileSync(resume, "%PDF-1.4\n% fictional test résumé\n");

    const plan = buildFillPlan("greenhouse", url, {
      firstName: "Sam",
      lastName: "Placeholder",
      email: "sam@example.com",
      phone: "+1 555 0100",
      linkedin: "linkedin.com/in/sam-placeholder",
      resumePath: resume,
      coverLetter: "I build reliable backend systems and would like to do that for Example Corp.",
      answers: {},
    });
    const flags: AutomationFlags = { browser: "on", mode: "fill", autosubmit: false, rate: "fast", tier3Sources: [] };

    const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
    try {
      const page = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
      const report = await fillPlanOnPage(page, plan, { flags });
      await page.waitForTimeout(800); // give a (forbidden) submit time to happen

      expect(report.submitted).toBe(false);
      expect(report.filled).toEqual(expect.arrayContaining(["firstName", "lastName", "email", "phone", "resume", "linkedin", "coverLetter"]));
      expect(await page.inputValue("#first_name")).toBe("Sam");
      expect(await page.inputValue("#email")).toBe("sam@example.com");
      expect(await page.locator("#resume").evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe("Sam_Placeholder_Resume.pdf");
      // the gate: nothing was POSTed and the page is still the form
      expect(submissions).toBe(0);
      expect(page.url()).toBe(url);

      const shot = process.env.JOBFLOW_E2E_SCREENSHOT;
      if (shot) {
        await page.evaluate(() => {
          const b = document.createElement("div");
          b.textContent = "JobFlow stopped here — review every field, then submit yourself.";
          b.style.cssText = "position:sticky;top:0;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:10px 12px;font:600 13px system-ui;margin-bottom:16px";
          document.body.prepend(b);
        });
        await page.screenshot({ path: shot, fullPage: true });
      }
    } finally {
      await browser.close();
    }
  }, 60_000);
});
