// Frame sequences → video. Both recorders (live screencast and deterministic frame
// rendering) write numbered JPEGs plus a list of [file, seconds] holds; `encodeFrames` turns
// that into a constant-30fps H.264 clip of an exact length with ffmpeg's concat demuxer.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util.mjs";

export class FrameSink {
  constructor(dir) {
    this.dir = dir;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.frames = []; // { file, t } — t in seconds from the clip start
    this.n = 0;
  }
  /** store a frame shown from time t (seconds) */
  add(buf, t) {
    const file = join(this.dir, `f${String(this.n++).padStart(6, "0")}.jpg`);
    writeFileSync(file, buf);
    this.frames.push({ file, t });
    return file;
  }
  /** repeat the last frame from time t (no new image) */
  get count() {
    return this.frames.length;
  }
  /**
   * Encode [from, from+duration) to `out` at `fps`. Frames before `from` collapse into the
   * opening frame; the last frame holds to the end.
   */
  async encode(out, { from = 0, duration, fps = 30, size }) {
    const fr = this.frames.filter((f) => f.t < from + duration);
    if (!fr.length) throw new Error(`no frames for ${out}`);
    // the frame showing at `from`
    let startIdx = 0;
    for (let i = 0; i < fr.length; i++) if (fr[i].t <= from) startIdx = i;
    const seq = fr.slice(startIdx).map((f, i) => ({ file: f.file, t: i === 0 ? 0 : f.t - from }));
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < seq.length; i++) {
      const end = i + 1 < seq.length ? seq[i + 1].t : duration;
      const d = Math.max(0.001, end - seq[i].t);
      lines.push(`file '${seq[i].file}'`, `duration ${d.toFixed(4)}`);
    }
    lines.push(`file '${seq[seq.length - 1].file}'`);
    const list = join(this.dir, "list.ffconcat");
    writeFileSync(list, lines.join("\n") + "\n");
    const scale = size ? `,scale=${size.w}:${size.h}:flags=lanczos,setsar=1` : "";
    await run("ffmpeg", [
      "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `fps=${fps}${scale},format=yuv420p`,
      "-t", duration.toFixed(3),
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-tune", "stillimage", "-r", String(fps),
      out,
    ]);
    return out;
  }
}
