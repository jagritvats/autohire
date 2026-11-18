#!/usr/bin/env node
// Quality check: a contact sheet of frames from a clip or a final video — at every scene
// boundary (from the timeline) and a few mid-scene — so a person (or an agent) can look.
//   node scripts/video/frames.mjs <video.mp4> [timeline.json] [--every 4] [--out sheet.png]
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { probeDuration, run, WORK } from "./lib/util.mjs";

const argv = process.argv.slice(2);
const [file, tlFile] = argv.filter((a, i) => !a.startsWith("--") && !["--every", "--out"].includes(argv[i - 1]));
const every = Number(process.argv[process.argv.indexOf("--every") + 1]) || 0;
const outArg = process.argv.indexOf("--out");
const dur = await probeDuration(file);
let times = [];
if (tlFile) {
  const tl = JSON.parse(readFileSync(tlFile, "utf8"));
  for (const s of tl.scenes) times.push(s.start + 0.15, s.start + s.dur * 0.5, s.start + s.dur - 0.2);
} else if (every) for (let t = 0.3; t < dur; t += every) times.push(t);
else times = [0.3, dur * 0.25, dur * 0.5, dur * 0.75, dur - 0.3];
times = times.filter((t) => t >= 0 && t < dur);
const dir = join(WORK, "contact");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [i, t] of times.entries()) {
  await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale=480:-2,drawtext=text='${t.toFixed(1)}s':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6`, join(dir, `c${String(i).padStart(3, "0")}.png`)]);
}
const cols = 3;
const out = outArg > 0 ? process.argv[outArg + 1] : join(WORK, "contact.png");
await run("ffmpeg", ["-v", "error", "-y", "-pattern_type", "glob", "-i", join(dir, "c*.png"), "-vf", `tile=${cols}x${Math.ceil(times.length / cols)}:padding=6:color=white`, "-frames:v", "1", out]);
console.log(out, times.length, "frames");
