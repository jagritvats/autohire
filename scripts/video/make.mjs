#!/usr/bin/env node
// JobFlow's videos, reproducibly: narration (ElevenLabs) → timeline → scenes (the real web
// app in demo mode, real terminal captures, our own title cards) → MP4 + .srt + poster.
//
//   node scripts/video/make.mjs <video…|all> [--only scene,scene] [--steps tts,record,assemble] [--draft]
//
// Videos: walkthrough, trailer, guide-start, guide-mcp, reel-ranked, reel-gate, reel-mcp.
// See scripts/video/README.md (needs ELEVENLABS_API_KEY for new narration, ffmpeg,
// Playwright + Chromium, a built web app, and capture-cli.mjs / capture-mcp.mjs run first).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assemble } from "./lib/assemble.mjs";
import { recordScene } from "./lib/record.mjs";
import { startServer, stopServer } from "./lib/server.mjs";
import { buildTimeline, loadNarration } from "./lib/timeline.mjs";
import { OUT, VIDEO_DIR, WORK, ensureDir, launchBrowser } from "./lib/util.mjs";

const ALL = ["walkthrough", "trailer", "guide-start", "guide-mcp", "reel-ranked", "reel-gate", "reel-mcp"];
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const ids = args.filter((a, i) => !a.startsWith("--") && !["--only", "--steps", "--out"].includes(args[i - 1]));
const videos = ids.includes("all") ? ALL : ids;
if (!videos.length) {
  console.error(`usage: make.mjs <${ALL.join("|")}|all> [--only scenes] [--steps tts,record,assemble] [--draft]`);
  process.exit(2);
}
const steps = new Set((flag("--steps") ?? "tts,record,assemble").split(","));
const only = flag("--only") ? new Set(flag("--only").split(",")) : null;
const draft = args.includes("--draft");
const outDir = flag("--out") ?? join(OUT, "out");

async function specFor(id) {
  const file = join(VIDEO_DIR, "specs", `${id.startsWith("reel-") ? "reels" : id}.mjs`);
  const mod = await import(pathToFileURL(file).href);
  return id.startsWith("reel-") ? mod.default[id] : mod.default;
}

let browser = null;
const summary = [];
let ttsChars = 0;
try {
  for (const id of videos) {
    const narr = loadNarration(id);
    const spec = await specFor(id);
    const tl = await buildTimeline(narr, spec, { dryRun: !steps.has("tts") });
    tl.music = narr.music;
    tl.chapters = !!spec.chapters;
    ttsChars += tl.ttsChars;
    const work = ensureDir(join(WORK, id));
    writeFileSync(join(work, "timeline.json"), JSON.stringify(tl, null, 1));
    console.log(`▸ ${id}: ${tl.total.toFixed(1)} s, ${tl.scenes.length} scenes${tl.ttsChars ? `, ${tl.ttsChars} new TTS characters` : ""}`);
    const size = spec.size ?? { w: 1920, h: 1080 };
    const clips = [];
    if (steps.has("record")) {
      browser ??= await launchBrowser();
      // the web app only when a scene shows it (the form-filler scenes use a local file)
      const flat = (v) => (v.kind === "seq" ? v.parts.flatMap((p) => flat(p.visual)) : [v]);
      const wanted = tl.scenes.filter((s) => !only || only.has(s.id)).flatMap((s) => flat(spec.visuals[s.id] ?? {}));
      if (wanted.some((v) => v.kind === "live" && !v.noServer)) await startServer();
      for (const [i, scene] of tl.scenes.entries()) {
        const clip = join(work, "scenes", `${String(i).padStart(2, "0")}-${scene.id}.mp4`);
        clips.push(clip);
        if (only && !only.has(scene.id) && existsSync(clip)) continue;
        const visual = spec.visuals[scene.id];
        if (!visual) throw new Error(`${id}: no visual for scene "${scene.id}"`);
        const t0 = Date.now();
        await recordScene(browser, { visual, scene, index: i, tl, size, workDir: ensureDir(join(work, "scenes", scene.id)), out: clip });
        console.log(`  ✓ ${scene.id} (${scene.dur.toFixed(1)} s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      await stopServer();
    } else {
      for (const [i, scene] of tl.scenes.entries()) clips.push(join(work, "scenes", `${String(i).padStart(2, "0")}-${scene.id}.mp4`));
    }
    if (steps.has("assemble")) {
      const r = await assemble({ tl, spec, clips, workDir: work, outDir: ensureDir(spec.outSub ? join(outDir, spec.outSub) : outDir), draft });
      for (const o of r.outputs) console.log(`  → ${o.file} (${o.seconds ? `${o.seconds.toFixed(1)} s, ` : ""}${(o.bytes / 1e6).toFixed(1)} MB)`);
      summary.push({ id, total: tl.total, outputs: r.outputs, chapters: tl.scenes.map((s) => ({ id: s.id, chapter: s.chapter, start: s.start })) });
    }
  }
} finally {
  await stopServer();
  await browser?.close();
}
if (summary.length) {
  // merge with earlier runs: one entry per video, the latest render wins
  const file = join(outDir, `summary${draft ? ".draft" : ""}.json`);
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { videos: [] };
  const videosOut = [...prev.videos.filter((v) => !summary.some((s) => s.id === v.id)), ...summary];
  writeFileSync(file, JSON.stringify({ videos: videosOut }, null, 1));
}
console.log(`done · new TTS characters this run: ${ttsChars}`);
