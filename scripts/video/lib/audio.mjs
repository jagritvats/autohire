// The soundtrack: narration lines placed at their timeline times, an optional music bed
// (ElevenLabs music, generated once and cached — never third-party music) ducked under the
// voice, light synthesized whooshes on cuts, then EBU R128 loudness normalisation to -16 LUFS.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, ensureDir, run } from "./util.mjs";

export const MOODS = {
  calm: {
    ms: 150_000,
    prompt: "Warm, unhurried instrumental background music for a software walkthrough: soft felt piano, gentle plucked acoustic guitar, light brushed percussion, low warm pads. Optimistic and calm, steady 88 bpm, no vocals, no big drops, even dynamics throughout so a voice sits clearly on top.",
  },
  trailer: {
    ms: 62_000,
    prompt: "Confident, modern instrumental music for a 60 second product trailer: tight muted guitar and warm synth bass, crisp light drums, rising energy with a clean final hit and a short tail at the end. Hopeful, editorial, 112 bpm, no vocals.",
  },
  reel: {
    ms: 42_000,
    prompt: "Upbeat, bright instrumental music for a short vertical social video: punchy light drums, plucky synth, warm bass, energetic but not aggressive, 120 bpm, no vocals, clean ending.",
  },
};

export async function musicBed(mood) {
  const m = MOODS[mood];
  if (!m) return null;
  const dir = ensureDir(join(CACHE, "music"));
  const file = join(dir, `${mood}.mp3`);
  if (existsSync(file)) return file;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.warn(`  no music bed "${mood}" cached and no ELEVENLABS_API_KEY — continuing without music`);
    return null;
  }
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ prompt: m.prompt, music_length_ms: m.ms, model_id: "music_v1" }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`music ${res.status}: ${(await res.text()).slice(0, 200)}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch (e) {
    console.warn(`  music bed "${mood}" unavailable (${e.message}) — continuing without music`);
    return null;
  }
}

/** a soft whoosh, synthesized (pink noise through a sweeping band) */
export async function whoosh() {
  const file = join(ensureDir(join(CACHE, "sfx")), "whoosh.wav");
  if (existsSync(file)) return file;
  await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=0.7:amplitude=0.6:seed=7",
    "-af", "highpass=f=250,lowpass=f=5200,bandpass=f=1400:width_type=o:w=1.6,afade=t=in:st=0:d=0.32:curve=exp,afade=t=out:st=0.32:d=0.38:curve=exp,volume=0.55,aformat=sample_rates=48000:channel_layouts=stereo",
    file]);
  return file;
}

/**
 * Build the final soundtrack (48 kHz stereo WAV) for a timeline.
 * opts: { music: mood|null, musicVolume, sfx: [seconds], out }
 */
export async function soundtrack(tl, { music, musicVolume = 0.16, sfx = [], out }) {
  const lines = tl.scenes.flatMap((s) => s.lines.map((l) => ({ mp3: l.mp3, at: s.start + l.start })));
  const inputs = [];
  const parts = [];
  lines.forEach((l, i) => {
    inputs.push("-i", l.mp3);
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(l.at * 1000)}:all=1[v${i}]`);
  });
  let n = lines.length;
  parts.push(`${lines.map((_, i) => `[v${i}]`).join("")}amix=inputs=${lines.length}:normalize=0:dropout_transition=0,apad,atrim=0:${tl.total.toFixed(3)}[voice]`);
  const mixIns = ["[voiceOut]"];
  const bed = music ? await musicBed(music) : null;
  if (bed) {
    inputs.push("-stream_loop", "-1", "-i", bed);
    const fadeOut = Math.max(0, tl.total - 2.5);
    parts.push(`[voice]asplit=2[voiceOut][key]`);
    parts.push(`[${n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${tl.total.toFixed(3)},volume=${musicVolume},afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOut.toFixed(2)}:d=2.4[bed]`);
    parts.push(`[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=25:release=450:makeup=1[ducked]`);
    mixIns.push("[ducked]");
    n++;
  } else parts.push(`[voice]anull[voiceOut]`);
  if (sfx.length) {
    const w = await whoosh();
    sfx.forEach((t, i) => {
      inputs.push("-i", w);
      parts.push(`[${n}:a]adelay=${Math.round(Math.max(0, t - 0.3) * 1000)}:all=1[s${i}]`);
      mixIns.push(`[s${i}]`);
      n++;
    });
  }
  parts.push(`${mixIns.join("")}amix=inputs=${mixIns.length}:normalize=0:dropout_transition=0,atrim=0:${tl.total.toFixed(3)}[mix]`);
  const raw = out.replace(/\.wav$/, ".raw.wav");
  await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", parts.join(";"), "-map", "[mix]", "-ar", "48000", "-ac", "2", raw]);
  // two-pass loudnorm: measure, then apply linearly
  const m = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { stderr: true });
  const j = JSON.parse(String(m).slice(String(m).lastIndexOf("{"), String(m).lastIndexOf("}") + 1) || "{}");
  const ln = j.input_i
    ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`
    : "loudnorm=I=-16:TP=-1.5:LRA=11";
  await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", `${ln},aresample=48000`, "-ar", "48000", out]);
  return out;
}
