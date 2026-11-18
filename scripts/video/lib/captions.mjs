// Captions from the narration timeline: an .srt for every video (timed from the TTS word
// alignment), and burned-in ASS subtitles for the social cuts — phrase captions for the
// trailer, word-by-word highlight for the vertical reels.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, ensureDir } from "./util.mjs";

/** words of a line with absolute times; when the spoken text differs from the caption text,
 *  caption words are spread over the line by character position */
export function captionWords(line, offset) {
  const textWords = line.text.split(/\s+/).filter(Boolean);
  if (line.say === line.text && line.words.length === textWords.length) {
    return line.words.map((w, i) => ({ w: textWords[i], start: offset + w.start, end: offset + w.end }));
  }
  const total = line.text.length;
  const span = Math.max(0.2, (line.words.at(-1)?.end ?? line.dur) - (line.words[0]?.start ?? 0));
  const t0 = offset + (line.words[0]?.start ?? 0);
  let pos = 0;
  return textWords.map((w) => {
    const i = line.text.indexOf(w, pos);
    pos = i + w.length;
    return { w, start: t0 + (i / total) * span, end: t0 + (pos / total) * span };
  });
}

/** split a line's words into cues of at most `max` characters, breaking at punctuation first */
function chunk(words, max) {
  const cues = [];
  let cur = [];
  const len = (ws) => ws.map((w) => w.w).join(" ").length;
  for (const w of words) {
    if (cur.length && len([...cur, w]) > max) {
      // prefer to end the cue after the last punctuation in it
      let cut = cur.length;
      for (let k = cur.length - 1; k >= Math.ceil(cur.length / 2); k--) if (/[,.;:—?!]$/.test(cur[k].w)) { cut = k + 1; break; }
      cues.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);
  return cues;
}

const ts = (s, sep = ",") => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};

/** two balanced lines for a cue */
function twoLines(text, max = 42) {
  if (text.length <= max) return text;
  const words = text.split(" ");
  let best = text;
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const s = Math.max(a.length, b.length);
    if (s < score) {
      score = s;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

export function cuesOf(tl, { maxChars = 84 } = {}) {
  const cues = [];
  for (const sc of tl.scenes) {
    for (const line of sc.lines) {
      const ws = captionWords(line, sc.start + line.start);
      for (const c of chunk(ws, maxChars)) cues.push({ start: c[0].start, end: c.at(-1).end, words: c, text: c.map((w) => w.w).join(" ") });
    }
  }
  // hold each cue until shortly before the next (readability), never overlapping
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.start ?? Infinity;
    cues[i].end = Math.min(Math.max(cues[i].end + 0.35, cues[i].start + 1.0), next - 0.05);
  }
  return cues;
}

export function writeSrt(tl, file) {
  const cues = cuesOf(tl);
  writeFileSync(file, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${twoLines(c.text)}\n`).join("\n"));
  return cues.length;
}

// ── burned-in captions (ASS) ──

/** Schibsted Grotesk Bold as a TTF for libass (Google Fonts serves TTF to plain clients) */
export async function captionFontDir() {
  const dir = ensureDir(join(CACHE, "fonts"));
  const file = join(dir, "SchibstedGrotesk-Bold.ttf");
  if (!existsSync(file)) {
    try {
      const css = await (await fetch("https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@700", { headers: { "user-agent": "curl/8" }, signal: AbortSignal.timeout(30_000) })).text();
      const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
      if (url) writeFileSync(file, Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer()));
    } catch (e) {
      console.warn("  couldn't fetch Schibsted Grotesk for captions:", e.message);
    }
  }
  return dir;
}

const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const assEsc = (s) => s.replace(/\\/g, "\\\\").replace(/{/g, "(").replace(/}/g, ")");

/**
 * Phrase captions (trailer, 16:9 or square): paper text on an ink box, bottom centre.
 */
export function writePhraseAss(tl, file, { w, h, size, marginV, maxChars = 46 }) {
  const cues = cuesOf(tl, { maxChars });
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Schibsted Grotesk,${size},&H00E7F1F6,&H00E7F1F6,&H1015191C,&H8015191C,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.32)},0,2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${assEsc(c.text)}`);
  writeFileSync(file, head + ev.join("\n") + "\n");
}

/**
 * Reel captions: big, two to four words at a time, the word being spoken in vermilion.
 * Bottom of the text sits at y = h - marginV (keep it clear of the platforms' UI).
 */
export function writeWordAss(tl, file, { w = 1080, h = 1920, size = 84, marginV = 440, perCue = 3 }) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Schibsted Grotesk,${size},&H00E7F1F6,&H00E7F1F6,&H0015191C,&H6015191C,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,2,70,70,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  for (const sc of tl.scenes) {
    for (const line of sc.lines) {
      const ws = captionWords(line, sc.start + line.start);
      // group into short phrases, breaking after punctuation
      const groups = [];
      let g = [];
      for (const x of ws) {
        g.push(x);
        if (g.length >= perCue || /[,.;:—?!]$/.test(x.w)) {
          groups.push(g);
          g = [];
        }
      }
      if (g.length) groups.push(g);
      groups.forEach((grp, gi) => {
        const groupEnd = gi + 1 < groups.length ? groups[gi + 1][0].start : grp.at(-1).end + 0.3;
        grp.forEach((x, k) => {
          const start = x.start;
          const end = k + 1 < grp.length ? grp[k + 1].start : groupEnd;
          const text = grp.map((y, j) => (j === k ? `{\\c&H003F67E0&}${assEsc(y.w)}{\\c&H00E7F1F6&}` : assEsc(y.w))).join(" ");
          ev.push(`Dialogue: 0,${assTime(start)},${assTime(Math.max(end, start + 0.05))},Word,,0,0,0,,{\\fad(0,0)}${text}`);
        });
      });
    }
  }
  writeFileSync(file, head + ev.join("\n") + "\n");
}
