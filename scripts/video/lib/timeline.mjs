// Narration → timeline. Every scene's length comes from its narration: a lead-in, each line
// with a gap after it, a tail (and a minimum length when the picture needs longer). The
// recorders key their actions to these line start times, so picture and voice stay in sync.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL, lineSay, lineText, speak } from "./tts.mjs";
import { VIDEO_DIR } from "./util.mjs";

export function loadNarration(id) {
  const dir = join(VIDEO_DIR, "narration");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (doc.id === id) return doc;
    for (const r of doc.reels ?? []) {
      if (r.id === id) return { ...r, voice: r.voice ?? doc.voice, model: r.model ?? doc.model, voiceSettings: r.voiceSettings ?? doc.voiceSettings, music: r.music ?? doc.music };
    }
  }
  throw new Error(`no narration "${id}"`);
}

/**
 * spec.scenes[id] may set: pre (s before the first line), gap (between lines), post (after the
 * last), min (minimum scene length), gaps (per-line override array).
 */
export async function buildTimeline(narr, spec, { dryRun = false } = {}) {
  let t = 0;
  let chars = 0;
  const scenes = [];
  for (const sc of narr.scenes) {
    const opt = spec.scenes?.[sc.id] ?? {};
    const pre = opt.pre ?? spec.defaults?.pre ?? 0.5;
    const gap = opt.gap ?? spec.defaults?.gap ?? 0.45;
    const post = opt.post ?? spec.defaults?.post ?? 0.7;
    let local = pre;
    const lines = [];
    for (const [i, l] of sc.lines.entries()) {
      // the model: the spec's, else the narration file's, else Eleven v4
      const a = await speak(l, { voice: narr.voice, settings: narr.voiceSettings, model: spec.model ?? narr.model ?? DEFAULT_MODEL, dryRun });
      chars += a.chars;
      lines.push({ text: lineText(l), say: lineSay(l), start: local, dur: a.duration, mp3: a.mp3, words: a.words, tags: a.tags });
      local += a.duration + (i < sc.lines.length - 1 ? opt.gaps?.[i] ?? gap : 0);
    }
    const dur = Math.max(local + post, opt.min ?? 0);
    scenes.push({ id: sc.id, chapter: sc.chapter ?? null, start: t, dur, lines });
    t += dur;
  }
  return { id: narr.id, title: narr.title, voice: narr.voice, model: spec.model ?? narr.model ?? DEFAULT_MODEL, total: t, scenes, ttsChars: chars };
}
