#!/usr/bin/env node
// Reproducible README screenshots. Runs the BUILT web app in demo mode — an offline,
// fully fictional corpus and the fictional "Alex Example" candidate (JOBFLOW_DEMO_DATA=1) —
// so screenshots never depend on live APIs and never show a real person or listing.
//
//   pnpm --filter @jobflow/web build && node scripts/screenshots.mjs [--only jobs,settings]
//
// Writes docs/screenshots/*.png: every page in the dark theme, the key pages again in the
// light theme (*-light.png), 375px-wide mobile views (*-mobile*.png), and the guide captures
// (jobs-checklist, jobs-keyboard, jobs-saved-search, onboarding-review).
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
// an invented candidate for the onboarding capture — never a real person
const DEMO_RESUME = `Sam Placeholder
sam@example.com · github.com/sam-placeholder · Lisbon, Portugal

SUMMARY
Backend engineer with 5 years of experience building APIs and data pipelines in Go and Python.

EXPERIENCE
Senior Software Engineer, Example Logistics — Mar 2022 – Present
- Built a Go service that routes 40k shipment events per minute through Kafka into PostgreSQL
- Cut p99 API latency from 900ms to 180ms by adding Redis caching and query indexes
Software Engineer, Placeholder Analytics — Jan 2020 – Feb 2022
- Wrote Python ETL jobs on Airflow that load 2TB a day into Snowflake
- Moved 14 services to Kubernetes with Terraform-managed infrastructure

SKILLS
Go, Python, PostgreSQL, Kafka, Redis, Kubernetes, Terraform, AWS, Airflow`;
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

  // ── guide captures (dark, desktop) — last, because they add a saved search and read a
  // résumé into the in-memory store, which would otherwise show up in the shots above ──
  const g = await (await context("dark", { width: 1440, height: 900 })).newPage();
  shot = shooter(g);
  const hideChecklist = async (p) => {
    await p.locator("#get-started button", { hasText: "later" }).click().catch(() => undefined);
  };
  // the "Get started" checklist on its own
  await shot("jobs-checklist", "/", { wait: "#get-started", element: "#get-started" });
  // keyboard in use: the second card selected, the shortcut line expanded
  await shot("jobs-keyboard", "/", {
    wait: CARD,
    before: async (p) => {
      await hideChecklist(p);
      for (const k of ["j", "j", "?"]) await p.keyboard.press(k);
      await p.waitForSelector(`${CARD}[data-selected]`, { timeout: 2000 }).catch(() => undefined);
    },
  });
  // a saved search as a Jobs tab: what the search hides, plus a rail filter's hidden report
  if (!ONLY || ONLY.has("jobs-saved-search")) {
    await g.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const viewId = await g.evaluate(async () => {
      const r = await fetch("/api/searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // a view over your corpus only (asSource: false) — nothing is fetched live
        body: JSON.stringify({ op: "save", name: "Remote backend", text: "backend --remote", asSource: false, asView: true }),
      });
      return (await r.json()).search?.id ?? null;
    });
    if (viewId)
      await shot("jobs-saved-search", `/?view=${viewId}`, {
        wait: CARD,
        before: async (p) => {
          await hideChecklist(p);
          await p.locator(".filter-rail .chip", { hasText: "anywhere" }).first().click();
          await p.waitForSelector(".ux-hidden-report[role=status]", { timeout: 5000 }).catch(() => undefined);
        },
      });
  }
  // onboarding step 2 — "Check what we found" — from a pasted, fictional résumé
  await shot("onboarding-review", "/onboarding", {
    fullPage: true,
    before: async (p) => {
      await p.fill("textarea", DEMO_RESUME);
      await p.getByRole("button", { name: "Read pasted text" }).click();
      await p.waitForSelector("text=Contact", { timeout: 15_000 });
      await p.evaluate(() => window.scrollTo(0, 0));
    },
  });

  await browser.close();
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}
console.log(`\n${shots.length} screenshots → docs/screenshots/`);
