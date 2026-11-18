#!/usr/bin/env node
// Writes docs/guides/video-walkthrough.md — every video's narration with chapter timestamps,
// the accessible text alternative to the videos — from the narration files and the timelines
// make.mjs saved ($VIDEO_OUT/work/<id>/timeline.json; without them, chapters get no times).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNarration } from "./lib/timeline.mjs";
import { lineText } from "./lib/tts.mjs";
import { ROOT, WORK } from "./lib/util.mjs";

const VIDEOS = [
  { id: "walkthrough", file: "jobflow-walkthrough.mp4", what: "The whole product in about three and a half minutes: setup, sync, the Jobs feed and match cards, filters, a Job page, Search, Tailor, the apply checklist and the review gate, Applications, MCP." },
  { id: "trailer", file: "jobflow-trailer.mp4", what: "A one-minute introduction. Also as a captioned cut and a 1:1 square cut for social media." },
  { id: "guide-start", file: "jobflow-guide-get-started.mp4", what: "Terminal first: clone, install, `jobflow init --sample`, `jobflow sync`, `jobflow feed`, `jobflow show`, `jobflow serve`." },
  { id: "guide-mcp", file: "jobflow-guide-mcp.mp4", what: "Adding `jobflow mcp` to Claude Code, then an illustrative conversation built from real tool output: `search_jobs`, `get_job`, `prepare_application` (a dry run), and you running `jobflow apply --fill`." },
  { id: "reel-ranked", file: "reels/jobflow-reel-ranked.mp4", what: "Vertical, ~30 s: ranked by fit to your résumé, with the honest card." },
  { id: "reel-gate", file: "reels/jobflow-reel-gate.mp4", what: "Vertical, ~30 s: the form-filler stops at the review screen; you press submit." },
  { id: "reel-mcp", file: "reels/jobflow-reel-mcp.mp4", what: "Vertical, ~30 s: JobFlow from an AI assistant over MCP; your data stays on your machine." },
];

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const out = [];
out.push(`# JobFlow videos: transcripts

The narration of every JobFlow video, with chapter times, as a text alternative. The videos
themselves are **attached to the GitHub release** (MP4, with an \`.srt\` caption file each). They
show an offline demo: a **fictional** candidate and **fictional** companies and job boards
(\`JOBFLOW_DEMO_DATA=1\`). Terminal scenes replay real command output; the AI-assistant chat is an
illustrative conversation built from real JobFlow tool output.

How they're made, and how to regenerate them: [\`scripts/video/README.md\`](../../scripts/video/README.md).

| Video | What it covers |
|---|---|
${VIDEOS.map((v) => `| [${loadNarration(v.id).title}](#${slug(loadNarration(v.id).title)}) | ${v.what} |`).join("\n")}
`);

function slug(t) {
  // GitHub's heading anchors: drop punctuation, each space becomes a hyphen
  return t.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
}

for (const v of VIDEOS) {
  const narr = loadNarration(v.id);
  const tlFile = join(WORK, v.id, "timeline.json");
  const tl = existsSync(tlFile) ? JSON.parse(readFileSync(tlFile, "utf8")) : null;
  const start = (id) => tl?.scenes.find((s) => s.id === id)?.start;
  out.push(`\n## ${narr.title}\n`);
  out.push(`File: \`${v.file}\`${tl ? ` · ${mmss(tl.total)}` : ""}. ${v.what}\n`);
  for (const sc of narr.scenes) {
    const t = start(sc.id);
    const head = sc.chapter ?? sc.id;
    out.push(`**${t != null ? `${mmss(t)} · ` : ""}${head}**\n`);
    out.push(sc.lines.map(lineText).join(" ") + "\n");
  }
}
out.push(`\n---\n\nSee also: [Getting started](../getting-started.md) · [Web app tour](web-app-tour.md) · [AI agents (MCP)](ai-agents-mcp.md)\n`);
const file = join(ROOT, "docs", "guides", "video-walkthrough.md");
writeFileSync(file, out.join("\n"));
console.log(`wrote ${file}`);
