// Terminal scenes from captured sessions (capture-cli.mjs): a typed command, then the
// session's real bytes with their real timing — long pauses compressed — as [t, text] writes
// for pages/terminal.html.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./util.mjs";

export const PROMPT = "\x1b[90m~/jobflow\x1b[0m \x1b[31m❯\x1b[0m ";

export function loadRec(name) {
  return JSON.parse(readFileSync(join(OUT, "cli", `${name}.json`), "utf8"));
}

/**
 * steps: { at?, wait?, type: "type"|"play"|"prompt"|"clear"|"note"|"head", … }
 *   type  — { cmd, cps } types a command at the prompt and presses Enter
 *   play  — { rec, maxGap, speed, dropHeader } plays a capture (pnpm's "> …" lines are kept)
 *   note  — { text } a dim line (e.g. output skipped)
 *   head  — { title, kicker } changes the heading above the window
 * A step without `at` starts `wait` (default 0.35 s) after the previous one ends.
 */
export function termScript(steps) {
  const writes = [];
  const heads = [];
  let t = 0;
  let promptShown = false;
  const w = (time, text) => writes.push([Number(time.toFixed(3)), text]);
  for (const s of steps) {
    t = s.at ?? t + (s.wait ?? 0.35);
    switch (s.type) {
      case "head":
        heads.push([t, { title: s.title, kicker: s.kicker }]);
        break;
      case "prompt":
        w(t, PROMPT);
        promptShown = true;
        break;
      case "clear":
        w(t, "\x1b[2J\x1b[3J\x1b[H");
        promptShown = false;
        break;
      case "type": {
        if (!promptShown) w(t, PROMPT);
        t += s.lead ?? 0.35;
        const cps = s.cps ?? 22;
        let k = 0;
        for (const ch of s.cmd) {
          w(t, ch);
          // a person's rhythm: a beat after spaces and dashes, faster inside words
          t += (1 / cps) * (ch === " " ? 1.8 : ch === "-" ? 1.3 : 0.85 + ((k++ * 7919) % 30) / 100);
        }
        t += s.hold ?? 0.45;
        w(t, "\r\n");
        promptShown = false;
        break;
      }
      case "note":
        w(t, `\x1b[90m${s.text}\x1b[0m\r\n`);
        break;
      case "play": {
        const rec = loadRec(s.rec);
        const maxGap = s.maxGap ?? 0.6;
        const speed = s.speed ?? 1;
        let prev = 0;
        let first = true;
        for (const [et, text] of rec.events) {
          const gap = first ? 0.05 : Math.min(maxGap, (et - prev) / speed);
          first = false;
          prev = et;
          t += gap;
          w(t, text);
        }
        t += s.tail ?? 0.2;
        if (s.thenPrompt !== false) {
          w(t, PROMPT);
          promptShown = true;
        }
        break;
      }
    }
    if (s.endAt != null) t = Math.max(t, s.endAt);
  }
  return { writes, heads, end: t };
}
