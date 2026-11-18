// Scene clips + soundtrack → the final MP4 (H.264 + AAC, 30 fps), its .srt, a poster PNG,
// and the burned-caption variants (trailer: captioned 16:9 and a 1:1 square; reels: word
// highlight).
import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { soundtrack } from "./audio.mjs";
import { captionFontDir, writePhraseAss, writeSrt, writeWordAss } from "./captions.mjs";
import { ensureDir, probeDuration, run } from "./util.mjs";

const H264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-profile:v", "high", "-movflags", "+faststart"];
const AAC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];

export async function assemble({ tl, spec, clips, workDir, outDir, draft = false }) {
  ensureDir(outDir);
  const name = spec.output ?? tl.id;
  // 1. picture: concatenate the scene clips (same codec settings → no re-encode)
  const list = join(workDir, "clips.ffconcat");
  writeFileSync(list, "ffconcat version 1.0\n" + clips.map((c) => `file '${c}'`).join("\n") + "\n");
  const picture = join(workDir, "picture.mp4");
  await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture]);
  // 2. sound
  const sfx = (spec.whooshes ?? []).map((id) => tl.scenes.find((s) => s.id === id)?.start).filter((t) => t != null && t > 0.2);
  const audio = await soundtrack(tl, { music: spec.music === false ? null : spec.music ?? tl.music, musicVolume: spec.musicVolume, sfx, out: join(workDir, "soundtrack.wav") });
  // 3. mux (+ burned captions for vertical reels)
  const mp4 = join(outDir, `${name}${draft ? ".draft" : ""}.mp4`);
  const fontsdir = await captionFontDir();
  if (spec.burnWords) {
    const ass = join(workDir, "words.ass");
    writeWordAss(tl, ass, spec.burnWords);
    await run("ffmpeg", ["-y", "-v", "error", "-i", picture, "-i", audio, "-vf", `ass=${ass}:fontsdir=${fontsdir}`, ...H264, ...AAC, "-shortest", mp4]);
  } else {
    await run("ffmpeg", ["-y", "-v", "error", "-i", picture, "-i", audio, "-c:v", "copy", "-movflags", "+faststart", ...AAC, "-shortest", mp4]);
  }
  // 4. captions file, poster
  const srt = join(outDir, `${name}${draft ? ".draft" : ""}.srt`);
  const cues = writeSrt(tl, srt);
  const poster = join(outDir, `${name}${draft ? ".draft" : ""}.poster.png`);
  await run("ffmpeg", ["-y", "-v", "error", "-ss", String(spec.posterAt ?? 1.5), "-i", picture, "-frames:v", "1", poster]);
  const outputs = [mp4, srt, poster];
  // 5. social variants of the trailer
  if (spec.captionedVariant) {
    const ass = join(workDir, "phrases.ass");
    writePhraseAss(tl, ass, { w: 1920, h: 1080, size: 54, marginV: 70 });
    const cap = join(outDir, `${name}.captioned${draft ? ".draft" : ""}.mp4`);
    await run("ffmpeg", ["-y", "-v", "error", "-i", picture, "-i", audio, "-vf", `ass=${ass}:fontsdir=${fontsdir}`, ...H264, ...AAC, "-shortest", cap]);
    outputs.push(cap);
    // 1:1 — the 16:9 picture on paper, captions in the band below it
    const sq = join(outDir, `${name}.square${draft ? ".draft" : ""}.mp4`);
    const sqAss = join(workDir, "square.ass");
    writePhraseAss(tl, sqAss, { w: 1080, h: 1080, size: 46, marginV: 150, maxChars: 34 });
    await run("ffmpeg", ["-y", "-v", "error", "-i", picture, "-i", audio, "-filter_complex",
      `[0:v]scale=1080:-2:flags=lanczos,pad=1080:1080:0:170:color=0xf6f1e7,ass=${sqAss}:fontsdir=${fontsdir}[v]`, "-map", "[v]", "-map", "1:a", ...H264, ...AAC, "-shortest", sq]);
    outputs.push(sq);
  }
  const report = [];
  for (const f of outputs) report.push({ file: f, bytes: statSync(f).size, seconds: f.endsWith(".mp4") ? await probeDuration(f) : null });
  if (spec.copyPosterAs) copyFileSync(poster, join(outDir, spec.copyPosterAs));
  return { outputs: report, cues };
}
