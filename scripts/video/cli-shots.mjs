#!/usr/bin/env node
// docs/screenshots/cli-*.png from REAL terminal output with FICTIONAL data: the `shot-*`
// sessions capture-cli.mjs records (the sample persona Alex Example and the demo corpus, in
// demo mode), drawn in the Editorial terminal window (pages/terminal.html) at 2×, at the
// same pixel sizes as before so the docs' layout doesn't move.
//
//   node scripts/video/capture-cli.mjs --only shot-feed,shot-search,shot-apply,shot-doctor,shot-profile
//   node scripts/video/cli-shots.mjs
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRec } from "./lib/term.mjs";
import { ROOT, VIDEO_DIR, launchBrowser } from "./lib/util.mjs";

const SHOTS = [
  { file: "cli-feed.png", rec: "shot-feed", w: 2232, h: 1198 },
  { file: "cli-search.png", rec: "shot-search", w: 2232, h: 1316 },
  { file: "cli-apply.png", rec: "shot-apply", w: 2356, h: 1276 },
  { file: "cli-doctor.png", rec: "shot-doctor", w: 2116, h: 926 },
  { file: "cli-profile.png", rec: "shot-profile", w: 2216, h: 808 },
];
const PROMPT = "\x1b[90m~/jobflow\x1b[0m \x1b[31m❯\x1b[0m ";

const browser = await launchBrowser();
try {
  for (const s of SHOTS) {
    const rec = loadRec(s.rec);
    const cssW = s.w / 2;
    const cssH = s.h / 2;
    const fontSize = s.fontSize ?? 14;
    const lineH = Math.ceil(fontSize * 1.18) + 1; // xterm rounds rows up to whole pixels
    // the window fills the frame: 22 px of paper around, a 42 px title bar, 40 px of padding
    const rows = Math.floor((cssH - 56 - 42 - 40) / lineH);
    const cols = Math.floor((cssW - 44 - 44) / (fontSize * 0.6));
    const body = rec.events.map((e) => e[1]).join("").replace(/\s+$/, "");
    const data = { cols, rows, fontSize, width: cssW - 44, shot: true, barTitle: "~/jobflow", writes: [[0, `${PROMPT}${rec.cmd}\r\n${body}`]] };
    const ctx = await browser.newContext({ viewport: { width: cssW, height: cssH }, deviceScaleFactor: 2 });
    await ctx.addInitScript(`window.__data = ${JSON.stringify(data)};`);
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(join(VIDEO_DIR, "pages", "terminal.html")).href, { waitUntil: "load" });
    await page.evaluate(() => window.__ready);
    // fit the rows to the frame from the cell height xterm actually measured
    // (a smaller font when the output needs more rows than fit)
    const need = body.split("\n").length + 1;
    const fitted = await page.evaluate(
      async ([cssH, need]) => {
        const t = window.__term;
        let rows = 0;
        for (let fs = t.options.fontSize; fs >= 10; fs -= 0.5) {
          t.options.fontSize = fs;
          await new Promise((r) => setTimeout(r, 30));
          const win = document.querySelector(".win").getBoundingClientRect().height;
          const rowH = (win - 82) / t.rows;
          rows = Math.floor((cssH - 44 - 82) / rowH);
          if (rows >= need) break;
        }
        t.resize(t.cols, rows);
        return rows;
      },
      [cssH, need],
    );
    await page.evaluate(() => window.__frame(1));
    const out = join(ROOT, "docs", "screenshots", s.file);
    await page.screenshot({ path: out });
    await ctx.close();
    const lines = body.split("\n").length + 1;
    console.log(`✓ ${s.file} (${s.w}×${s.h}, ${lines} lines in ${fitted} rows${lines > fitted ? " — CUT OFF, shorten the command" : ""})`);
  }
} finally {
  await browser.close();
}
