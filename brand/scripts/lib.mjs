// Shared helpers for the brand scripts: paths, a Chromium launcher, HTML -> PNG.
// Playwright comes from the monorepo root devDependencies.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(BRAND, "..");

export async function launch() {
  const { chromium } = require("playwright");
  try {
    return await chromium.launch();
  } catch (err) {
    // the bundled build may not match the installed browsers: use any Chromium on disk
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
    const dirs = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const d of dirs) {
      const exe = join(base, d, "chrome-linux64", "chrome");
      if (existsSync(exe)) return chromium.launch({ executablePath: exe });
    }
    throw err;
  }
}

/** Render an HTML file (by path) or string to PNG at exact CSS size × scale. */
export async function png(browser, { file, html, width, height, scale = 2, out, transparent = false }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  if (file) await page.goto(pathToFileURL(file).href);
  else await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  await page.close();
}
