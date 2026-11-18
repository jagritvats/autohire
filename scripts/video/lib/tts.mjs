// ElevenLabs narration, one call per line, cached by (voice, model, settings, text) so an
// unchanged line is never generated twice. The key comes ONLY from ELEVENLABS_API_KEY in
// the environment; it is never logged or written anywhere.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, ensureDir, hash, probeDuration } from "./util.mjs";

const MODEL = "eleven_multilingual_v2";
const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true };

export const lineText = (l) => (typeof l === "string" ? l : l.text);
export const lineSay = (l) => (typeof l === "string" ? l : l.say ?? l.text);

/** words with start/end seconds, from ElevenLabs' character alignment */
export function wordsFromAlignment(al) {
  const words = [];
  let cur = null;
  const chars = al.characters;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const s = al.character_start_times_seconds[i];
    const e = al.character_end_times_seconds[i];
    if (/\s/.test(ch)) {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { w: "", start: s, end: e };
    cur.w += ch;
    cur.end = e;
  }
  if (cur) words.push(cur);
  return words;
}

/**
 * Generate (or reuse) one line. Returns { mp3, duration, words, chars, cached }.
 */
export async function speak(line, { voice, settings, dryRun = false } = {}) {
  const dir = ensureDir(join(CACHE, "tts"));
  const say = lineSay(line);
  const st = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const key = hash(voice, MODEL, st, say);
  const mp3 = join(dir, `${key}.mp3`);
  const meta = join(dir, `${key}.json`);
  if (existsSync(mp3) && existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8"));
    return { mp3, duration: m.duration, words: m.words, chars: 0, cached: true };
  }
  if (dryRun) throw new Error(`not cached: "${say.slice(0, 50)}…"`);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set (narration isn't cached yet)");
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text: say, model_id: MODEL, voice_settings: st }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) break;
      const body = (await res.text()).slice(0, 300);
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`TTS ${res.status}: ${body}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  const data = await res.json();
  writeFileSync(mp3, Buffer.from(data.audio_base64, "base64"));
  const words = wordsFromAlignment(data.alignment);
  const duration = await probeDuration(mp3);
  writeFileSync(meta, JSON.stringify({ say, voice, model: MODEL, settings: st, duration, words }, null, 1));
  appendFileSync(join(dir, "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), voice, chars: say.length }) + "\n");
  return { mp3, duration, words, chars: say.length, cached: false };
}
