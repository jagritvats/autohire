// ElevenLabs narration, one call per line, cached by (voice, model, settings, text) so an
// unchanged line is never generated twice — and a new model or setting regenerates every
// line. The key comes ONLY from ELEVENLABS_API_KEY in the environment; it is never logged
// or written anywhere.
//
// Eleven v4 reads inline audio tags ("[warm] This is JobFlow."): they steer delivery and are
// not spoken. The timestamp alignment still lists the tags' characters, so captions drop
// them and keep the spoken words' own times.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, ensureDir, hash, probeDuration } from "./util.mjs";

export const DEFAULT_MODEL = "eleven_v4";
const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true };

/** a line without its audio tags: what is heard, and what captions show */
export function stripTags(s) {
  return s.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
}

export const lineText = (l) => stripTags(typeof l === "string" ? l : l.text);
/** what the voice is sent: tags included */
export const lineSay = (l) => (typeof l === "string" ? l : l.say ?? l.text);

/**
 * Spoken words with start/end seconds, from ElevenLabs' character alignment. An audio tag's
 * characters ("[warm]", brackets included) are not words: they end the current word and are
 * left out, so the words are exactly `stripTags(text)`'s, each with its own spoken times.
 */
export function wordsFromAlignment(al) {
  const words = [];
  let cur = null;
  let inTag = false;
  const chars = al.characters;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const s = al.character_start_times_seconds[i];
    const e = al.character_end_times_seconds[i];
    if (ch === "[") inTag = true;
    const sep = inTag || /\s/.test(ch);
    if (ch === "]") inTag = false;
    if (sep) {
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

/** each audio tag's span in the alignment: { tag, start, end } — for QA (tags aren't spoken) */
export function tagSpans(al) {
  const spans = [];
  let open = null;
  al.characters.forEach((ch, i) => {
    if (ch === "[") open = { tag: "", start: al.character_start_times_seconds[i] };
    if (open) open.tag += ch;
    if (ch === "]" && open) {
      spans.push({ ...open, end: al.character_end_times_seconds[i] });
      open = null;
    }
  });
  return spans;
}

/**
 * Generate (or reuse) one line. Returns { mp3, duration, words, tags, chars, cached }.
 */
export async function speak(line, { voice, settings, model = DEFAULT_MODEL, dryRun = false } = {}) {
  const dir = ensureDir(join(CACHE, "tts"));
  const say = lineSay(line);
  const st = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const key = hash(voice, model, st, say);
  const mp3 = join(dir, `${key}.mp3`);
  const meta = join(dir, `${key}.json`);
  if (existsSync(mp3) && existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8"));
    return { mp3, duration: m.duration, words: m.words, tags: m.tags ?? [], chars: 0, cached: true };
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
        body: JSON.stringify({ text: say, model_id: model, voice_settings: st }),
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
  const tags = tagSpans(data.alignment);
  const duration = await probeDuration(mp3);
  writeFileSync(meta, JSON.stringify({ say, voice, model, settings: st, duration, words, tags }, null, 1));
  appendFileSync(join(dir, "usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), voice, model, chars: say.length }) + "\n");
  return { mp3, duration, words, tags, chars: say.length, cached: false };
}
