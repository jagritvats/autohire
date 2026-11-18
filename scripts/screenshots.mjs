#!/usr/bin/env node
// Reproducible README screenshots. Runs the BUILT web app in demo mode — an offline,
// fully fictional corpus and the fictional "Alex Example" candidate (JOBFLOW_DEMO_DATA=1) —
// so screenshots never depend on live APIs and never show a real person or listing.
//
//   pnpm --filter @jobflow/web build && node scripts/screenshots.mjs [--only feed,settings]
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
  await shot("feed", "/", { wait: CARD });
  await shot("match-card", "/", { wait: CARD, element: CARD });
  // a card carrying caveats: red flags and/or a modeled (estimated) salary
  await shot("match-card-caveats", "/", { wait: CARD, element: `${CARD}:has(.match__flag), ${CARD}:has(.badge--estimate)` });
  await shot("search", "/searches", { before: search });
  await shot("discovery", "/discovery", { wait: ".onb-preset" });
  await shot("onboarding", "/onboarding");
  await shot("applications", "/applications", { wait: ".crm-row, .empty-note" });
  await shot("companies", "/companies", { wait: ".reg-row" });
  await shot("settings", "/settings");
  // tailor page for the top card
  const href = await dark
    .goto(`${BASE}/`)
    .then(() => dark.locator('a[href^="/tailor/"]').first().getAttribute("href"))
    .catch(() => null);
  if (href) await shot("tailor", href);

  // ── desktop, light ──
  const light = await (await context("light", { width: 1440, height: 900 })).newPage();
  shot = shooter(light);
  await shot("feed-light", "/", { wait: CARD });
  await shot("match-card-light", "/", { wait: CARD, element: CARD });
  await shot("settings-light", "/settings");
  await shot("discovery-light", "/discovery", { wait: ".onb-preset" });
  if (href) await shot("tailor-light", href);

  // ── mobile, 375px ──
  const mobileOpts = { isMobile: true, hasTouch: true };
  const m = await (await context("dark", { width: 375, height: 812 }, mobileOpts)).newPage();
  shot = shooter(m);
  await shot("feed-mobile", "/", { wait: CARD });
  await shot("feed-mobile-filters", "/", {
    wait: CARD,
    before: async (p) => {
      await p.click(".filter-bar button");
      await p.waitForSelector('.filter-rail[data-open="true"]');
    },
  });
  await shot("settings-mobile", "/settings");
  await shot("nav-mobile", "/settings", {
    before: async (p) => {
      await p.click(".app-header__menu");
    },
  });
  const ml = await (await context("light", { width: 375, height: 812 }, mobileOpts)).newPage();
  shot = shooter(ml);
  await shot("feed-mobile-light", "/", { wait: CARD });
  await shot("applications-mobile-light", "/applications", { wait: ".crm-row, .empty-note" });

  await browser.close();
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}
console.log(`\n${shots.length} screenshots → docs/screenshots/`);
