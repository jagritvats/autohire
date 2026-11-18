// Record one scene to a clip of exactly the scene's length.
//   page — one of our deterministic pages (pages/*.html): title cards, terminal, chat
//   live — the real web app in demo mode, driven by a script keyed to the narration
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPage } from "./render.mjs";
import { clock, Hand, newScenePage, startScreencast } from "./live.mjs";
import { startServer } from "./server.mjs";
import { BASE, ensureDir, run, sleep } from "./util.mjs";

/** an on-screen chapter label for live footage (a video annotation, styled apart from the app) */
async function chapterLabel(page, n, title, vertical) {
  await page.evaluate(
    ([n, title, vertical]) => {
      const el = document.createElement("div");
      el.id = "__chapter";
      el.innerHTML = `<span style="color:#e0673f;font-variant-numeric:tabular-nums">${String(n).padStart(2, "0")}</span><span style="opacity:.45;margin:0 .55em">/</span>${title}`;
      el.style.cssText = `position:fixed;z-index:2147483640;left:${vertical ? 24 : 36}px;bottom:${vertical ? 140 : 34}px;padding:.55em 1em;border-radius:999px;background:#1c1915;color:#f6f1e7;font:600 ${vertical ? 17 : 19}px "Schibsted Grotesk",system-ui,sans-serif;letter-spacing:.01em;box-shadow:0 10px 30px -12px rgba(0,0,0,.5);pointer-events:none;animation:__chin .5s cubic-bezier(.2,.8,.2,1) both, __chout .5s ease-in 3.6s both`;
      const st = document.createElement("style");
      st.textContent = "@keyframes __chin{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}@keyframes __chout{to{opacity:0;transform:translateY(8px)}}";
      document.documentElement.append(st, el);
    },
    [n, title, vertical],
  );
}

export async function recordScene(browser, { visual, scene, index, tl, size, workDir, out }) {
  const dur = scene.dur;
  const lineAt = (i, off = 0) => (scene.lines[Math.min(i, scene.lines.length - 1)]?.start ?? 0) + off;
  if (visual.kind === "seq") {
    // several shots in one scene: each part ends where the next begins (`until`, seconds or
    // a function of lineAt); each sees the scene's lines shifted to its own start
    const parts = [];
    let from = 0;
    for (const [k, p] of visual.parts.entries()) {
      const until = k === visual.parts.length - 1 ? dur : Math.min(dur, typeof p.until === "function" ? p.until(lineAt) : p.until);
      const sub = { ...scene, dur: until - from, lines: scene.lines.map((l) => ({ ...l, start: l.start - from })) };
      const clip = join(ensureDir(join(workDir, `part${k}`)), "part.mp4");
      await recordScene(browser, { visual: p.visual, scene: sub, index: k === 0 ? index : -1, tl: k === 0 ? tl : { ...tl, chapters: false }, size, workDir: join(workDir, `part${k}`), out: clip });
      parts.push(clip);
      from = until;
    }
    const list = join(workDir, "parts.ffconcat");
    writeFileSync(list, "ffconcat version 1.0\n" + parts.map((c) => `file '${c}'`).join("\n") + "\n");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
    return out;
  }
  if (visual.kind === "page") {
    const data = typeof visual.data === "function" ? visual.data({ scene, lineAt, dur }) : visual.data;
    return renderPage(browser, { page: visual.page, data, width: size.w, height: size.h, scale: visual.scale ?? 1, duration: dur, out, workDir: ensureDir(join(workDir, "frames")) });
  }
  if (visual.kind === "live") {
    if (visual.fresh) await startServer(visual.env ?? {});
    const view = { width: 1536, height: 864, scale: 1.25, colorScheme: "light", ...(visual.view ?? {}) };
    const { context, page } = await newScenePage(browser, view);
    page.on("pageerror", (e) => console.error(`  [${scene.id}] page error: ${e.message}`));
    const rec = await startScreencast(page, ensureDir(join(workDir, "frames")), { width: size.w, height: size.h });
    const hand = new Hand(page);
    // setup: get the page to its opening state (not in the clip)
    if (visual.url) await page.goto(`${BASE}${visual.url}`, { waitUntil: "load" });
    if (visual.setup) await visual.setup({ page, hand, BASE });
    await page.evaluate(() => document.fonts.ready);
    await hand.place(...(visual.cursor ?? [view.width * 0.62, view.height * 0.55]));
    await sleep(visual.settle ?? 600);
    const c = clock();
    rec.mark();
    c.reset();
    if (visual.chapter !== false && tl.chapters && scene.chapter) await chapterLabel(page, index + 1, scene.chapter, view.width < 600);
    const at = (i, off = 0) => c.at(lineAt(i, off));
    at.t = (s) => c.at(s);
    at.end = (off = 0) => c.at(dur + off);
    await visual.run({ page, hand, at, scene, dur, BASE, lineAt });
    await c.at(dur + 0.25);
    const sink = await rec.stop();
    await context.close();
    return sink.encode(out, { duration: dur, size });
  }
  throw new Error(`unknown visual kind for ${scene.id}`);
}
