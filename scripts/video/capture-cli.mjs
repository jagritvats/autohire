#!/usr/bin/env node
// Capture REAL terminal sessions for the videos: each command runs in a pseudo-terminal
// (util-linux `script`, with byte timing) against a fresh copy of this checkout and a
// throwaway home directory, with the FICTIONAL sample persona and demo mode
// (JOBFLOW_DEMO_DATA=1: fictional boards, no network). The terminal player replays the bytes
// with their real timing (long waits compressed). Absolute scratch paths are shown as `~`.
//
//   node scripts/video/capture-cli.mjs [--only sync,feed] [--fresh]
//
// Writes $VIDEO_OUT/cli/<name>.json: { cmd, cols, rows, events: [[seconds, text], …] }.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { OUT, ROOT, ensureDir, launchBrowser } from "./lib/util.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const fresh = args.includes("--fresh");
/** re-read the saved pty logs (after changing how they are cleaned) without re-running */
const reparse = args.includes("--reparse");
const CLI = ensureDir(join(OUT, "cli"));
const HOME = join(OUT, "cli-home"); // shown as ~
const REPO = join(HOME, "jobflow");
const COLS = 104;
const ROWS = 30;

/** a fictional résumé (never a real person) — the walkthrough imports it as a PDF */
const CV = `Sam Placeholder
sam@example.com · github.com/sam-placeholder · Lisbon, Portugal

SUMMARY
Backend engineer with 5 years of experience building APIs and data pipelines in Go and Python.

EXPERIENCE
Senior Software Engineer, Example Logistics — Mar 2022 – Present
- Built a Go service that routes 40k shipment events per minute through Kafka into PostgreSQL
- Cut p99 API latency from 900ms to 180ms by adding Redis caching and query indexes
Software Engineer, Placeholder Analytics — Jan 2020 – Feb 2022
- Wrote Python ETL jobs on Airflow that load 2TB a day into Snowflake
- Moved 14 services to Kubernetes with Terraform-managed infrastructure

SKILLS
Go, Python, PostgreSQL, Kafka, Redis, Kubernetes, Terraform, AWS, Airflow`;

async function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

async function prepare() {
  if (fresh && existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
  ensureDir(HOME);
  if (!existsSync(join(REPO, "package.json"))) {
    // a clean copy of this checkout — what `git clone` gives you (no node_modules, no builds)
    mkdirSync(REPO, { recursive: true });
    const tar = spawn("tar", ["-C", ROOT, "--exclude=node_modules", "--exclude=.next", "--exclude=.git", "--exclude=dist", "--exclude=*.tsbuildinfo", "--exclude=.video", "--exclude=.claude", "--exclude=docs/screenshots", "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
    const untar = spawn("tar", ["-C", REPO, "-xf", "-"], { stdio: ["pipe", "inherit", "inherit"] });
    tar.stdout.pipe(untar.stdin);
    await new Promise((r, j) => untar.on("close", (c) => (c === 0 ? r() : j(new Error("copy failed")))));
  }
  const pdf = join(HOME, "sam-placeholder-cv.pdf");
  if (!existsSync(pdf)) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(`<pre style="font:13px/1.5 Helvetica,Arial,sans-serif;white-space:pre-wrap;margin:48px">${CV.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`);
    await page.pdf({ path: pdf, format: "A4" });
    await browser.close();
  }
}

/** run one command in a pty; returns the parsed { events } */
function capture(name, cmd, { env = {}, killAfter = null, cwd = REPO, cols = COLS } = {}) {
  const tlog = join(CLI, `${name}.timing`);
  const olog = join(CLI, `${name}.log`);
  return new Promise((resolve, reject) => {
    const p = spawn("script", ["-q", "-e", "-T", tlog, "-O", olog, "-c", `stty cols ${cols} rows ${ROWS}; ${cmd}`], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
        JOBFLOW_DEMO_DATA: "1",
        JOBFLOW_AUTH: "none",
        LLM_PROVIDER: "echo",
        npm_config_update_notifier: "false",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY ?? "", NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? "" } : {}),
        ...env,
      },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    let timer = null;
    if (killAfter) timer = setTimeout(() => {
      try {
        process.kill(-p.pid, "SIGINT");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {}
      }, 4000);
    }, killAfter * 1000);
    p.on("close", () => {
      if (timer) clearTimeout(timer);
      try {
        resolve(parse(name, cmd, tlog, olog));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parse(name, cmd, tlog, olog) {
  const raw = readFileSync(olog);
  const nl = raw.indexOf(0x0a);
  let body = raw.subarray(nl + 1);
  const timing = readFileSync(tlog, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number));
  // chunk boundaries; a scratch path split across two chunks moves whole into the first,
  // so it can be shown as `~`
  const ends = [];
  let acc = 0;
  for (const [, bytes] of timing) ends.push((acc += bytes));
  const needle = Buffer.from(HOME);
  for (let a = body.indexOf(needle); a >= 0; a = body.indexOf(needle, a + 1)) {
    for (let k = 0; k < ends.length; k++) if (ends[k] > a && ends[k] < a + needle.length) ends[k] = a + needle.length;
  }
  const events = [];
  let t = 0;
  let off = 0;
  for (const [k, [delay]] of timing.entries()) {
    t += delay;
    const end = Math.max(off, ends[k]);
    const text = body.subarray(off, end).toString("utf8").split(HOME).join("~");
    off = end;
    if (text) events.push([Number(t.toFixed(3)), text]);
  }
  const out = { name, cmd, cols: COLS, rows: ROWS, events };
  writeFileSync(join(CLI, `${name}.json`), JSON.stringify(out));
  const plain = events.map((e) => e[1]).join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  console.log(`✓ ${name}: ${events.length} chunks, ${t.toFixed(1)}s, ${plain.length} chars`);
  return out;
}

const PLAIN = { JOBFLOW_DEMO_SYNC_PACE: "1" };
const SESSIONS = [
  ["install", "pnpm install"],
  ["build", "pnpm -r build"],
  // the walkthrough's import of a (fictional) PDF résumé; its data is set aside afterwards
  ["init-resume", "pnpm jobflow init --yes --resume ~/sam-placeholder-cv.pdf", { after: () => renameSync(join(HOME, ".jobflow"), join(HOME, `.jobflow-walkthrough-${Date.now()}`)) }],
  ["init-sample", "pnpm jobflow init --sample"],
  ["sync", "pnpm jobflow sync", { env: PLAIN }],
  ["feed", "pnpm jobflow feed --limit 6"],
  ["show", "pnpm jobflow show 5"],
  ["apply", "pnpm jobflow apply 1"],
  // stills for docs/screenshots/cli-*.png (cli-shots.mjs): the `jobflow` binary itself
  ["shot-feed", "node apps/cli/bin/jobflow.mjs feed -n 3", { display: "jobflow feed -n 3" }],
  ["shot-search", "node apps/cli/bin/jobflow.mjs search '\"backend engineer\"' --remote -n 3", { display: "jobflow search '\"backend engineer\"' --remote -n 3" }],
  ["shot-apply", "node apps/cli/bin/jobflow.mjs apply 2", { display: "jobflow apply 2" }],
  ["shot-doctor", "node apps/cli/bin/jobflow.mjs doctor --offline", { display: "jobflow doctor --offline" }],
  ["shot-profile", "node apps/cli/bin/jobflow.mjs me", { display: "jobflow me" }],
  ["serve", "pnpm jobflow serve", { killAfter: 14 }],
  ["mcp-add", "claude mcp add --transport stdio jobflow -- node ~/jobflow/apps/cli/bin/jobflow.mjs mcp"],
  // wide, so the server path isn't wrapped before it is shown as ~
  ["mcp-list", "claude mcp list", { killAfter: 60, cols: 220 }],
];

if (!reparse) await prepare();
for (const [name, cmd, opts = {}] of SESSIONS) {
  if (only && !only.has(name)) continue;
  if (name === "serve" && !(await portFree(3000))) {
    console.warn("port 3000 is busy — skipping the serve capture");
    continue;
  }
  if (reparse) {
    const r = parse(name, opts.display ?? cmd, join(CLI, `${name}.timing`), join(CLI, `${name}.log`));
    writeFileSync(join(CLI, `${name}.json`), JSON.stringify(r));
    continue;
  }
  // `~` in a command means the throwaway home
  const r = await capture(name, cmd.replaceAll("~/", `${HOME}/`), opts);
  r.cmd = opts.display ?? cmd;
  writeFileSync(join(CLI, `${name}.json`), JSON.stringify(r));
  opts.after?.();
}
