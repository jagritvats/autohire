// Fresh product imagery for the brand assets — fictional data only.
//
//   pnpm -r build && node brand/scripts/capture.mjs
//
// 1. seeds a scratch PGlite store (brand/.out/demo-store) with the offline, fully fictional
//    demo corpus (the web app's JOBFLOW_DEMO_DATA corpus + modeled pay estimates);
// 2. runs the REAL `jobflow` CLI against it and saves the output (ANSI) for the posters;
// 3. starts the BUILT web app on that store (port 3507, own process group) and captures
//    match cards, the Jobs page and a Job page in light and dark at 2x;
// 4. runs the REAL autofill against a local Greenhouse-style form with an invented
//    applicant and captures the form at the review gate (never submitted; zero POSTs).
// Everything lands in brand/.out/captures (git-ignored); build_assets.mjs reads it.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, ROOT, launch } from "./lib.mjs";

const OUT = join(BRAND, ".out", "captures");
const STORE = join(BRAND, ".out", "demo-store");
const PORT = Number(process.env.BRAND_DEMO_PORT ?? 3507);
const BASE = `http://localhost:${PORT}`;
if (!BRAND || BRAND === "/" || !STORE.startsWith(BRAND)) throw new Error("bad brand path");
rmSync(STORE, { recursive: true, force: true });
mkdirSync(STORE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const env = { ...process.env, JOBFLOW_DATA_DIR: STORE, JOBFLOW_STORE: "", DATABASE_URL: "", LLM_PROVIDER: "echo", JOBFLOW_AUTH: "none" };

// 1. seed
execFileSync("npx", ["tsx", join(BRAND, "scripts", "seed-cli-demo.ts")], { cwd: ROOT, env, stdio: "inherit" });

// 2. the CLI, for real (FORCE_COLOR keeps its ANSI styling for the terminal artwork)
// (the CLI prints its "next:" hints on stderr, so keep both streams, in order)
const cli = (args, file) => {
  const out = execFileSync("sh", ["-c", 'node "$0" "$@" 2>&1', join(ROOT, "apps", "cli", "bin", "jobflow.mjs"), ...args], {
    cwd: ROOT,
    env: { ...env, FORCE_COLOR: "1", COLUMNS: "100" },
    encoding: "utf8",
  });
  // the scratch folder holding the résumé is elided to "…/" (the only edit: a long local path)
  const shown = out.split(`${join(BRAND, ".out")}/`).join("…/");
  writeFileSync(join(OUT, file), `$ jobflow ${args.join(" ")}\n${shown}`);
};
// the fictional candidate's contact details + a résumé file, as a user would set them, so
// the dry run and the filled form below show the same applicant
const RESUME = join(BRAND, ".out", "Alex_Example_Resume.pdf");
writeFileSync(RESUME, "%PDF-1.4\n% fictional résumé for brand imagery\n");
cli(["profile", "set", "phone", "+1 555 0100"], "profile-set.ansi");
cli(["profile", "set", "resume-path", RESUME], "profile-set.ansi");
cli(["feed", "-n", "3"], "cli-feed.ansi");
cli(["apply", "1"], "cli-apply.ansi");
cli(["mcp", "--help"], "cli-mcp-help.ansi");

// 3. the web app on the same store
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: join(ROOT, "apps", "web"),
  env: { ...env, NODE_ENV: "production" },
  stdio: ["ignore", "ignore", "pipe"],
  detached: true, // own process group: stopping it stops next-server too
});
server.stderr.on("data", (d) => process.stderr.write(d));
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/me`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("web app didn't start");
}

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Apply · Backend Engineer · Example Corp</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:560px;margin:28px auto;padding:0 16px;color:#1b1f24;background:#fff}
  h1{font-size:22px;margin:0 0 4px} p.sub{color:#57606a;margin:0 0 20px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
  input[type=text],input[type=email],input[type=tel],textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;font-family:inherit}
  .attach{display:inline-block;padding:7px 12px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;font-size:13px}
  #resume{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
  #resume-name{margin-left:8px;font-size:13px;color:#1a7f37}
  button{margin-top:20px;padding:10px 18px;border:0;border-radius:6px;background:#1f883d;color:#fff;font-size:14px}
</style></head><body>
<h1>Backend Engineer</h1><p class="sub">Example Corp · Remote</p>
<form id="application_form" method="post" action="/submit" enctype="multipart/form-data">
  <label for="first_name">First name</label><input type="text" id="first_name" name="first_name">
  <label for="last_name">Last name</label><input type="text" id="last_name" name="last_name">
  <label for="email">Email</label><input type="email" id="email" name="email">
  <label for="phone">Phone</label><input type="tel" id="phone" name="phone">
  <label>Résumé/CV</label><span class="attach">Attach</span>
  <input type="file" id="resume" name="resume"><span id="resume-name"></span>
  <label for="linkedin">LinkedIn profile</label><input type="text" id="linkedin" name="job_application[linkedin]">
  <label for="cover_letter_text">Cover letter</label><textarea id="cover_letter_text" name="cover_letter" rows="4"></textarea>
  <button type="submit" id="submit_app">Submit application</button>
</form>
<script>document.getElementById('resume').addEventListener('change',e=>{document.getElementById('resume-name').textContent=e.target.files[0]?.name||''})</script>
</body></html>`;

async function reviewGate(browser) {
  // the real autofill (packages/autofill), via tsx so its TS source runs as-is
  let posts = 0;
  const srv = createServer((req, res) => {
    if (req.method === "POST") posts++;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "POST" ? "<h1>Application submitted</h1>" : FORM);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/apply`;
  const { buildFillPlan, fillPlanOnPage } = await import(join(ROOT, "packages", "autofill", "dist", "index.js")).catch(() => ({}));
  if (!buildFillPlan) throw new Error("build packages/autofill first (pnpm -r build)");
  const plan = buildFillPlan("greenhouse", url, {
    firstName: "Alex",
    lastName: "Example",
    email: "alex@example.com",
    phone: "+1 555 0100",
    linkedin: "linkedin.com/in/alex-example",
    resumePath: RESUME,
    // no cover letter drafted (`jobflow tailor --kind cover`), so that field is left for you
    answers: {},
  });
  const page = await browser.newPage({ viewport: { width: 620, height: 600 }, deviceScaleFactor: 2 });
  const report = await fillPlanOnPage(page, plan, { flags: { browser: "on", mode: "fill", autosubmit: false, rate: "fast", tier3Sources: [] } });
  await page.waitForTimeout(600);
  if (report.submitted || posts !== 0) throw new Error("the form was submitted — invariant #2 broken");
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: join(OUT, "review-gate.png"), fullPage: true });
  const box = await page.locator("#submit_app").boundingBox();
  writeFileSync(join(OUT, "review-gate.json"), JSON.stringify({ submit: box, width: 620, filled: report.filled, posts }));
  await page.close();
  srv.close();
}

async function web(browser) {
  await waitUp();
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
    const page = await ctx.newPage();
    const settle = async () => {
      await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;caret-color:transparent!important}" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(700);
    };
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector("article.match");
    const later = page.getByRole("button", { name: "later" });
    if (await later.count()) await later.first().click();
    await settle();
    await page.screenshot({ path: join(OUT, `jobs-${scheme}.png`) });
    // a card with a margin of page around it (the score numeral sits flush on the card edge)
    const card = async (sel, name) => {
      const el = page.locator(sel).first();
      if (!(await el.count())) return console.warn(`no card for ${name}`);
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      const m = 28;
      await page.screenshot({ path: join(OUT, `${name}-${scheme}.png`), clip: { x: b.x - m, y: b.y + 2, width: b.width + 2 * m, height: b.height - 4 } });
    };
    await card("article.match", "card-top");
    await card("article.match:has([data-estimate])", "card-estimate");
    await card("article.match:has(.match__flag)", "card-flag");
    const top = await page.locator("article.match a[href^='/jobs/']").first().getAttribute("href");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}${top}`, { waitUntil: "load" });
    await settle();
    await page.screenshot({ path: join(OUT, `job-${scheme}.png`) });
    await ctx.close();
  }
}

const browser = await launch();
try {
  await reviewGate(browser);
  await web(browser);
} finally {
  await browser.close();
  stop();
}
console.log(`captures in ${OUT}`);
process.exit(0);
