#!/usr/bin/env node
// Reproducible README screenshots. Runs the BUILT web app in demo mode — an offline,
// fully fictional corpus and the fictional "Alex Example" candidate (JOBFLOW_DEMO_DATA=1) —
// so screenshots never depend on live APIs and never show a real person or listing.
//
//   pnpm --filter @jobflow/web build && node scripts/screenshots.mjs
//
// Writes docs/screenshots/*.png. Needs Playwright + Chromium (`npx playwright install chromium`).
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
mkdirSync(OUT, { recursive: true });

let chromium, devices;
try {
  ({ chromium, devices } = require("playwright"));
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

const shots = [];
try {
  await waitUp();
  // Playwright's own Chromium, else JOBFLOW_CHROMIUM / a preinstalled build
  let executablePath;
  try {
    if (!existsSync(chromium.executablePath())) executablePath = [process.env.JOBFLOW_CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && existsSync(p));
  } catch {}
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: "en-US",
  });
  const page = await desktop.newPage();
  const shot = async (name, url, opts = {}) => {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 10_000 }).catch(() => undefined);
    if (opts.scrollTo) await page.locator(opts.scrollTo).first().scrollIntoViewIfNeeded().catch(() => undefined);
    if (opts.before) await opts.before(page);
    const file = join(OUT, `${name}.png`);
    if (opts.element) await page.locator(opts.element).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !!opts.fullPage });
    shots.push(file);
    console.log("✓", name);
  };

  await shot("feed", "/", { wait: "article.card" });
  await shot("match-card", "/", { wait: "article.card", element: "article.card" });
  await shot("search", "/search", {
    before: async (p) => {
      await p.fill(".search-bar input", '"backend engineer" --remote --posted 14d');
    },
  });
  await shot("discovery", "/sources", { wait: ".onb-preset" });
  await shot("onboarding", "/onboarding");
  await shot("applications", "/applications", { wait: ".crm-row" });
  await shot("profile", "/profile");
  await shot("settings", "/settings");
  // the Job page (fit, description, the apply checklist) for the top card
  const job = await page.goto(`${BASE}/`).then(() => page.locator('a[href^="/jobs/"]').first().getAttribute("href")).catch(() => null);
  if (job) await shot("job", job);
  // tailor page for the top card
  const href = await page.goto(`${BASE}/`).then(() => page.locator('a[href^="/tailor/"]').first().getAttribute("href")).catch(() => null);
  if (href) await shot("tailor", href);

  const mobile = await browser.newContext({ ...devices["iPhone 13"], colorScheme: "dark", reducedMotion: "reduce" });
  const mp = await mobile.newPage();
  await mp.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await mp.waitForSelector("article.card", { timeout: 10_000 }).catch(() => undefined);
  await mp.screenshot({ path: join(OUT, "feed-mobile.png") });
  console.log("✓ feed-mobile");
  await browser.close();
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}
console.log(`\n${shots.length + 1} screenshots → docs/screenshots/`);
