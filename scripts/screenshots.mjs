#!/usr/bin/env node
// Reproducible README screenshots. Runs the BUILT web app in demo mode — an offline,
// fully fictional corpus and the fictional "Alex Example" candidate (JOBFLOW_DEMO_DATA=1) —
// so screenshots never depend on live APIs and never show a real person or listing.
//
//   pnpm --filter @jobflow/web build && node scripts/screenshots.mjs [--only jobs,settings] [--style editorial]
//
// Writes docs/screenshots/*.png: every page in the light theme (Editorial's default), the key pages again in the
// dark theme (*-dark.png), 375px-wide mobile views (*-mobile*.png), and the guide captures
// (jobs-checklist, jobs-keyboard, jobs-saved-search, onboarding-review), all in one visual
// style — `--style` (default: Editorial, the app's default). Plus the style set
// (styles-<style>-light/dark.png: the Jobs page in each style; `--only styles` for just those).
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
// the visual style (apps/web/lib/style.ts); the docs set is taken in one style
const STYLES = ["editorial", "classic", "spark"];
const styleArg = process.argv.indexOf("--style");
const STYLE = styleArg > 0 ? process.argv[styleArg + 1] : "editorial";
if (!STYLES.includes(STYLE)) {
  console.error(`--style must be one of ${STYLES.join(", ")}`);
  process.exit(1);
}
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

  const context = async (colorScheme, viewport, extra = {}, style = STYLE) => {
    const c = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US", ...extra });
    // the style is a per-browser choice (localStorage), applied by the page's head script
    await c.addInitScript((s) => localStorage.setItem("jobflow-style", s), style);
    return c;
  };
  // "networkidle" may never come while the header's sync indicator polls: wait for load,
  // then give the page a few seconds to settle
  const settle = async (p, url) => {
    await p.goto(url, { waitUntil: "load" });
    await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  };
  const shooter = (page) => async (name, url, opts = {}) => {
    if (ONLY && !ONLY.has(name)) return;
    await settle(page, `${BASE}${url}`);
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

  // ── desktop, light (Editorial's default) ──
  const main = await (await context("light", { width: 1440, height: 900 })).newPage();
  let shot = shooter(main);
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
  await settle(main, `${BASE}/`);
  const job = await main
    .locator(CARD)
    .filter({ hasNotText: "in Applications" })
    .first()
    .locator('a[href^="/jobs/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  const href = await main
    .locator(`${CARD} a[href^="/tailor/"]`)
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (job) {
    await shot("job", job);
    await shot("job-apply", job, { scrollTo: "#apply" });
  }
  if (href) await shot("tailor", href);

  // ── desktop, dark ──
  const dark = await (await context("dark", { width: 1440, height: 900 })).newPage();
  shot = shooter(dark);
  await shot("jobs-dark", "/", { wait: CARD });
  await shot("match-card-dark", "/", { wait: CARD, element: CARD });
  if (job) await shot("job-dark", job);
  await shot("profile-dark", "/profile");
  await shot("settings-dark", "/settings");
  await shot("sources-dark", "/sources", { wait: ".onb-preset" });
  await shot("search-dark", "/search", { before: search });
  if (href) await shot("tailor-dark", href);

  // ── mobile, 375px ──
  const mobileOpts = { isMobile: true, hasTouch: true };
  const m = await (await context("light", { width: 375, height: 812 }, mobileOpts)).newPage();
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
  const ml = await (await context("dark", { width: 375, height: 812 }, mobileOpts)).newPage();
  shot = shooter(ml);
  await shot("jobs-mobile-dark", "/", { wait: CARD });
  await shot("applications-mobile-dark", "/applications", { wait: ".crm-row, .empty" });
  await shot("sources-mobile-dark", "/sources", { wait: ".onb-preset" });

  // ── the style set: the Jobs page in each style, light and dark (docs/screenshots/styles-*.png) ──
  for (const style of STYLES) {
    for (const scheme of ["light", "dark"]) {
      const name = `styles-${style}-${scheme}`;
      if (ONLY && !ONLY.has(name) && !ONLY.has("styles")) continue;
      const ctx = await context(scheme, { width: 1440, height: 900 }, {}, style);
      const p = await ctx.newPage();
      await settle(p, `${BASE}/`);
      await p.waitForSelector(CARD, { timeout: 10_000 }).catch(() => undefined);
      await p.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
      const file = join(OUT, `${name}.png`);
      await p.screenshot({ path: file });
      shots.push(file);
      console.log("✓", name);
      await ctx.close();
    }
  }

  // ── a few pages in the Classic style (the earlier design), for the README's style section:
  // docs/screenshots/classic-<page>-<light|dark>.png ──
  const classicPages = [
    ["jobs", "/", CARD],
    ["job", job, null],
    ["search", "/search", null],
    ["sources", "/sources", ".onb-preset"],
  ];
  for (const [page, url, wait] of classicPages) {
    if (!url) continue;
    for (const scheme of ["light", "dark"]) {
      const name = `classic-${page}-${scheme}`;
      if (ONLY && !ONLY.has(name) && !ONLY.has("classic")) continue;
      const ctx = await context(scheme, { width: 1440, height: 900 }, {}, "classic");
      const p = await ctx.newPage();
      await settle(p, `${BASE}${url}`);
      if (wait) await p.waitForSelector(wait, { timeout: 10_000 }).catch(() => undefined);
      if (page === "search") await search(p);
      await p.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
      const file = join(OUT, `${name}.png`);
      await p.screenshot({ path: file });
      shots.push(file);
      console.log("✓", name);
      await ctx.close();
    }
  }

  // ── guide captures (dark, desktop) — last, because they add a saved search and read a
  // résumé into the in-memory store, which would otherwise show up in the shots above ──
  const g = await (await context("light", { width: 1440, height: 900 })).newPage();
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
    await settle(g, `${BASE}/`);
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
