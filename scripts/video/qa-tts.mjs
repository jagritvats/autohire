#!/usr/bin/env node
// Listen-proxy checks on the narration, from the cached TTS (no API calls):
//  - speaking rate per line (a tag read aloud, or a garbled line, shows up as an outlier);
//  - each audio tag's span in the timestamp alignment: a tag is fine when its span is short,
//    or when the sound in it is quiet or is just the next word starting (the alignment often
//    parks a tag right before the word it colours). Flagged otherwise;
//  - tag text never reaches a caption word.
//   node scripts/video/qa-tts.mjs [video…]     (default: all)
import { join } from "node:path";
import { stripTags } from "./lib/tts.mjs";
import { buildTimeline, loadNarration } from "./lib/timeline.mjs";
import { run, VIDEO_DIR } from "./lib/util.mjs";
import { pathToFileURL } from "node:url";

const ALL = ["walkthrough", "trailer", "guide-start", "guide-mcp", "reel-ranked", "reel-gate", "reel-mcp"];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

async function rmsDb(mp3, from, to) {
  if (to - from < 0.02) return -99;
  const err = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", mp3, "-af", `atrim=${from.toFixed(3)}:${to.toFixed(3)},astats=metadata=0`, "-f", "null", "-"], { stderr: true });
  const m = err.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/);
  return m ? (m[1] === "-inf" ? -99 : Number(m[1])) : -99;
}

let flagged = 0;
let lines = 0;
let tags = 0;
for (const id of ids) {
  const narr = loadNarration(id);
  const spec = (await import(pathToFileURL(join(VIDEO_DIR, "specs", `${id.startsWith("reel-") ? "reels" : id}.mjs`)).href)).default;
  const tl = await buildTimeline(narr, id.startsWith("reel-") ? spec[id] : spec, { dryRun: true });
  let longest = 0;
  for (const sc of tl.scenes) {
    for (const l of sc.lines) {
      lines++;
      const words = l.words.length;
      const spoken = (l.words.at(-1)?.end ?? l.dur) - (l.words[0]?.start ?? 0);
      const wps = words / Math.max(0.1, spoken);
      if (wps < 1.4 || wps > 4.2) {
        flagged++;
        console.log(`  ! ${id}/${sc.id}: ${wps.toFixed(2)} words/s — "${l.text.slice(0, 60)}"`);
      }
      if (l.words.some((w) => /[[\]]/.test(w.w))) {
        flagged++;
        console.log(`  ! ${id}/${sc.id}: a caption word carries tag text`);
      }
      for (const t of l.tags ?? []) {
        tags++;
        const span = t.end - t.start;
        longest = Math.max(longest, span);
        if (span <= 0.05) continue;
        // the sound inside the span that isn't the next word's onset
        const next = l.words.find((w) => w.start >= t.end - 0.001);
        const quietUntil = Math.min(t.end, next ? next.start - 0.08 : t.end);
        const db = await rmsDb(l.mp3, t.start, Math.max(t.start, quietUntil));
        const spokenTag = span > 0.35 && db > -35;
        if (spokenTag) {
          flagged++;
          console.log(`  ! ${id}/${sc.id}: ${t.tag} spans ${span.toFixed(2)} s at ${db.toFixed(1)} dB — may be spoken`);
        }
      }
    }
  }
  console.log(`✓ ${id}: ${tl.total.toFixed(1)} s · longest tag span ${longest.toFixed(2)} s · model ${tl.model}`);
  if (stripTags(narr.title) !== narr.title) console.log(`  ! ${id}: tag in the title`);
}
console.log(`${lines} lines, ${tags} tags, ${flagged} flagged`);
process.exit(flagged ? 1 : 0);
