// Deterministic rendering of our own pages (title cards, the terminal player, the chat
// transcript): the page exposes `__frame(t)`, we step a virtual clock at 30 fps and
// screenshot only when something changed, so timing is exact and nothing stutters.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FrameSink } from "./frames.mjs";
import { FPS, VIDEO_DIR } from "./util.mjs";

/** CSS-animation pages: pause every animation and seek it to t (ms) */
const SEEK_JS = `
window.__frame ??= async (t) => {
  const anims = document.getAnimations();
  let moving = false;
  for (const a of anims) {
    a.pause();
    a.currentTime = t * 1000;
    const tm = a.effect.getComputedTiming();
    if (tm.progress !== null && tm.progress > 0 && tm.progress < 1) moving = true;
  }
  if (window.__onFrame) moving = (await window.__onFrame(t)) || moving;
  const was = window.__moving; window.__moving = moving;
  return moving || was !== moving;
};
`;

export async function renderPage(browser, { page: html, data, width, height, scale = 1, duration, out, workDir, fps = FPS }) {
  const context = await browser.newContext({ viewport: { width: Math.round(width / scale), height: Math.round(height / scale) }, deviceScaleFactor: scale });
  await context.addInitScript(`window.__data = ${JSON.stringify(data)};`);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`  [${html}] ${e.message}`));
  await page.goto(pathToFileURL(join(VIDEO_DIR, "pages", html)).href + `?${Date.now()}`, { waitUntil: "load" });
  await page.evaluate(SEEK_JS);
  await page.evaluate(() => window.__ready ?? null);
  await page.evaluate(() => document.fonts.ready);
  const sink = new FrameSink(workDir);
  const n = Math.ceil(duration * fps);
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const changed = await page.evaluate((t) => window.__frame(t), t);
    if (changed || i === 0) sink.add(await page.screenshot({ type: "jpeg", quality: 93 }), t);
  }
  await context.close();
  await sink.encode(out, { duration, fps, size: { w: width, h: height } });
  return out;
}
