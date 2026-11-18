import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT = resolve(VIDEO_DIR, "..", "..");
/** where everything generated goes — never inside git (see README) */
export const OUT = resolve(process.env.VIDEO_OUT || join(ROOT, ".video"));
export const WORK = join(OUT, "work");
export const CACHE = join(OUT, "cache");
export const PORT = Number(process.env.VIDEO_PORT || 3407);
export const BASE = `http://localhost:${PORT}`;
export const FPS = 30;

export function ensureDir(d) {
  mkdirSync(d, { recursive: true });
  return d;
}

export function hash(...parts) {
  return createHash("sha1").update(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\u0000")).digest("hex").slice(0, 16);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** run a command; resolve with stdout, reject with stderr on a non-zero exit */
export function run(cmd, args, opts = {}) {
  const { stderr: wantErr, ...spawnOpts } = opts;
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) => (code === 0 ? res(wantErr ? err : out) : rej(new Error(`${cmd} ${args.slice(0, 6).join(" ")}… exited ${code}: ${err.slice(-2000)}`))));
  });
}

export async function probeDuration(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(out.trim());
}

const require = createRequire(import.meta.url);
export async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    throw new Error("playwright isn't installed: pnpm add -Dw playwright && npx playwright install chromium");
  }
  let executablePath;
  try {
    if (!existsSync(chromium.executablePath())) executablePath = [process.env.JOBFLOW_CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && existsSync(p));
  } catch {}
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--font-render-hinting=none", "--disable-lcd-text"] });
}
