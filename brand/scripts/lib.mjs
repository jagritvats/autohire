// Shared helpers for the brand renderers: a Chromium launcher, the font-face block, and
// HTML -> PNG / PDF. Playwright comes from the monorepo's root devDependencies.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = join(BRAND, "..");
export const FONTS = join(BRAND, ".fonts");

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

/** @font-face rules for the three brand faces, from brand/.fonts (scripts/fetch-fonts.sh). */
export function fontFaces() {
  for (const f of ["Fraunces-VF.woff2", "Fraunces-Italic-VF.woff2", "SchibstedGrotesk-VF.woff2"]) {
    if (!existsSync(join(FONTS, f))) throw new Error(`missing brand/.fonts/${f}: run brand/scripts/fetch-fonts.sh`);
  }
  const u = (f) => pathToFileURL(join(FONTS, f)).href;
  return `
@font-face{font-family:"Fraunces";src:url("${u("Fraunces-VF.woff2")}") format("woff2");font-weight:100 900;font-style:normal}
@font-face{font-family:"Fraunces";src:url("${u("Fraunces-Italic-VF.woff2")}") format("woff2");font-weight:100 900;font-style:italic}
@font-face{font-family:"Schibsted Grotesk";src:url("${u("SchibstedGrotesk-VF.woff2")}") format("woff2");font-weight:400 900;font-style:normal}`;
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

/** Print an HTML file to a single-page PDF of the given CSS size (vector text and shapes). */
export async function pdf(browser, { file, width, height, out }) {
  const page = await browser.newPage({ viewport: { width: Math.round(width), height: Math.round(height) } });
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.pdf({ path: out, width: `${width}px`, height: `${height}px`, printBackground: true, pageRanges: "1" });
  await page.close();
}
