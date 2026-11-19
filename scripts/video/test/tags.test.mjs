// Audio tags ("[warm]") steer Eleven v4 and aren't spoken; captions must drop them and keep
// the spoken words' own times.   node --test scripts/video/test/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { captionWords, cuesOf } from "../lib/captions.mjs";
import { lineSay, lineText, stripTags, tagSpans, wordsFromAlignment } from "../lib/tts.mjs";

/** a fake character alignment: each character lasts `step`, tags take their own time too */
function align(text, step = 0.05, tagStep = 0.03) {
  const characters = [...text];
  const starts = [];
  const ends = [];
  let t = 0;
  let inTag = false;
  for (const ch of characters) {
    if (ch === "[") inTag = true;
    const d = inTag ? tagStep : step;
    starts.push(Number(t.toFixed(3)));
    t += d;
    ends.push(Number(t.toFixed(3)));
    if (ch === "]") inTag = false;
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

test("stripTags removes tags and the space around them, keeps punctuation", () => {
  assert.equal(stripTags("[warm] This is JobFlow."), "This is JobFlow.");
  assert.equal(stripTags("It fits. [short pause] It stops."), "It fits. It stops.");
  assert.equal(stripTags("[confident] Ranked by [excited] you."), "Ranked by you.");
  assert.equal(stripTags("No tags here."), "No tags here.");
});

test("lineText strips tags for captions; lineSay keeps them for the voice", () => {
  assert.equal(lineText("[warm] Hello there."), "Hello there.");
  assert.equal(lineSay("[warm] Hello there."), "[warm] Hello there.");
  const l = { text: "Run pnpm install.", say: "[calm] Run p-n-p-m install." };
  assert.equal(lineText(l), "Run pnpm install.");
  assert.equal(lineSay(l), "[calm] Run p-n-p-m install.");
});

test("spoken words leave the tag characters out and keep their own times", () => {
  const text = "[warm] Hi there. [short pause] Bye.";
  const words = wordsFromAlignment(align(text));
  assert.deepEqual(
    words.map((w) => w.w),
    ["Hi", "there.", "Bye."],
  );
  // "[warm] " = 6 tag chars × 0.03 + 1 space × 0.05 → "Hi" starts at 0.23
  assert.equal(words[0].start, 0.23);
  assert.equal(words[0].end, 0.33);
  // "Bye." starts after "[short pause] " (13 × 0.03 + 0.05)
  const bye = words[2];
  assert.ok(bye.start > words[1].end + 13 * 0.03, "the tag's span is skipped, not given to a word");
  assert.equal(words.map((w) => w.w).join(" "), stripTags(text));
});

test("tagSpans lists each tag with its span (QA: tags aren't spoken)", () => {
  const spans = tagSpans(align("[warm] Hi. [short pause] Bye."));
  assert.deepEqual(
    spans.map((s) => s.tag),
    ["[warm]", "[short pause]"],
  );
  assert.ok(Math.abs(spans[0].end - spans[0].start - 6 * 0.03) < 1e-9);
});

test("captions from a tagged line: one-to-one words, no tag text, spoken times", () => {
  const say = "[warm] This is JobFlow, on your machine.";
  const words = wordsFromAlignment(align(say));
  const line = { text: lineText(say), say, start: 1, dur: 3, words };
  const cw = captionWords(line, 10);
  assert.deepEqual(
    cw.map((w) => w.w),
    ["This", "is", "JobFlow,", "on", "your", "machine."],
  );
  assert.equal(cw[0].start, 10 + words[0].start);
  for (const w of cw) assert.ok(!w.w.includes("["));
  const tl = { scenes: [{ start: 0, lines: [{ ...line, start: 10 }] }] };
  const cues = cuesOf(tl);
  assert.equal(cues.map((c) => c.text).join(" "), "This is JobFlow, on your machine.");
});

test("a respelt, tagged line spreads caption words over the spoken span only", () => {
  const say = "[calm] Run p-n-p-m install.";
  const words = wordsFromAlignment(align(say));
  const line = { text: "Run pnpm install.", say, start: 0, dur: 2, words };
  const cw = captionWords(line, 0);
  assert.deepEqual(
    cw.map((w) => w.w),
    ["Run", "pnpm", "install."],
  );
  assert.equal(cw[0].start, words[0].start, "starts when speech starts, not at the tag");
  assert.ok(Math.abs(cw.at(-1).end - words.at(-1).end) < 1e-9);
});
