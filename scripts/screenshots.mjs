#!/usr/bin/env node
// Reproducible README screenshots. Runs the BUILT web app in demo mode — an offline,
// fully fictional corpus and the fictional "Alex Example" candidate (JOBFLOW_DEMO_DATA=1) —
// so screenshots never depend on live APIs and never show a real person or listing.
//
//   pnpm --filter @jobflow/web build && node scripts/screenshots.mjs [--only jobs,settings]
//
// Writes docs/screenshots/*.png: every page in the dark theme, the key pages again in the
// light theme (*-light.png), and 375px-wide mobile views (*-mobile*.png).
// Needs Playwright + Chromium (`npx playwright install chromium`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");
const PORT = Number(process.env.SCREENSHOT_PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1]?.split(",")) : null;
mkdirSync(OUT, { recursive: true });

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("playwright isn't installed: pnpm add -Dw playwright && npx playwright install chromium");
  process.exit(1);
}

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: join(ROOT, "apps", "web"),
  env: {
    ...process.env,
    JOBFLOW_DEMO_DATA: "1",
    JOBFLOW_STORE: "memory",
    JOBFLOW_AUTH: "none",
    LLM_PROVIDER: "echo",
    DATABASE_URL: "",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
  // own process group, so stopping it also stops next-server (npx doesn't forward signals)
  detached: true,
});
server.stderr.on("data", (d) => process.stderr.write(d));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("web app didn't start");
}

const CARD = "article.match";
const shots = [];
try {
  await waitUp();
  // Playwright's own Chromium, else JOBFLOW_CHROMIUM / a preinstalled build
  let executablePath;
  try {
    if (!existsSync(chromium.executablePath())) executablePath = [process.env.JOBFLOW_CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && existsSync(p));
  } catch {}
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  const context = (colorScheme, viewport, extra = {}) =>
    browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US", ...extra });
  const shooter = (page) => async (name, url, opts = {}) => {
    if (ONLY && !ONLY.has(name)) return;
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 10_000 }).catch(() => undefined);
    if (opts.scrollTo) await page.locator(opts.scrollTo).first().scrollIntoViewIfNeeded().catch(() => undefined);
    if (opts.before) await opts.before(page);
    const file = join(OUT, `${name}.png`);
    if (opts.element) await page.locator(opts.element).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !!opts.fullPage });
    // a page wider than the viewport is a layout bug — say so loudly
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.warn(`  ! ${name}: horizontal overflow of ${overflow}px`);
    shots.push(file);
    console.log("✓", name);
  };
  const search = async (p) => {
    await p.fill(".search-bar input", '"backend engineer" --remote --posted 14d');
  };

  // ── desktop, dark ──
  const dark = await (await context("dark", { width: 1440, height: 900 })).newPage();
  let shot = shooter(dark);
  await shot("jobs", "/", { wait: CARD });
  await shot("match-card", "/", { wait: CARD, element: CARD });
  // a card carrying caveats: red flags and/or a modeled (estimated) salary
  await shot("match-card-caveats", "/", { wait: CARD, element: `${CARD}:has(.match__flag), ${CARD}:has(.badge--estimate)` });
  await shot("search", "/search", { before: search });
  await shot("sources", "/sources", { wait: ".onb-preset" });
  await shot("companies", "/companies", { wait: ".reg-row" });
  await shot("onboarding", "/onboarding");
  await shot("applications", "/applications", { wait: ".crm-row, .empty" });
  await shot("profile", "/profile");
  await shot("settings", "/settings");
  // the Job page (fit, description, the apply checklist) for the top job not yet in
  // Applications (so the checklist shows), and Tailor for the top card
  await dark.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const job = await dark
    .locator(CARD)
    .filter({ hasNotText: "in Applications" })
    .first()
    .locator('a[href^="/jobs/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  const href = await dark
    .locator(`${CARD} a[href^="/tailor/"]`)
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (job) {
    await shot("job", job);
    await shot("job-apply", job, { scrollTo: "#apply" });
  }
  if (href) await shot("tailor", href);

  // ── desktop, light ──
  const light = await (await context("light", { width: 1440, height: 900 })).newPage();
  shot = shooter(light);
  await shot("jobs-light", "/", { wait: CARD });
  await shot("match-card-light", "/", { wait: CARD, element: CARD });
  if (job) await shot("job-light", job);
  await shot("profile-light", "/profile");
  await shot("settings-light", "/settings");
  await shot("sources-light", "/sources", { wait: ".onb-preset" });
  await shot("search-light", "/search", { before: search });
  if (href) await shot("tailor-light", href);

  // ── mobile, 375px ──
  const mobileOpts = { isMobile: true, hasTouch: true };
  const m = await (await context("dark", { width: 375, height: 812 }, mobileOpts)).newPage();
  shot = shooter(m);
  await shot("jobs-mobile", "/", { wait: CARD });
  await shot("jobs-mobile-filters", "/", {
    wait: CARD,
    before: async (p) => {
      await p.click(".filter-bar button");
      await p.waitForSelector('.filter-rail[data-open="true"]');
    },
  });
  if (job) await shot("job-mobile", job);
  await shot("profile-mobile", "/profile");
  await shot("settings-mobile", "/settings");
  await shot("nav-mobile", "/settings", {
    before: async (p) => {
      await p.click(".app-header__menu");
    },
  });
  const ml = await (await context("light", { width: 375, height: 812 }, mobileOpts)).newPage();
  shot = shooter(ml);
  await shot("jobs-mobile-light", "/", { wait: CARD });
  await shot("applications-mobile-light", "/applications", { wait: ".crm-row, .empty" });
  await shot("sources-mobile-light", "/sources", { wait: ".onb-preset" });

  await browser.close();
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}
console.log(`\n${shots.length} screenshots → docs/screenshots/`);
