#!/usr/bin/env node
// Fails if tracked files contain markers of real personal data (a résumé, the original
// author's identity, personal projects) — the regression guard for the open-source scrub.
// Fixtures must use fictional people at example.com.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DENY = [
  /jagrit/i,
  /\bvats\d*@/i,
  /NexusAlgo/,
  /ZFH ledger/i,
  /Resume_\d+_/i,
  /@gmail\.com/i,
];
// files allowed to mention the denylist (this script and the publishing guide)
const ALLOW = new Set(["scripts/check-pii.mjs", "docs/internal/PUBLISHING.md"]);
// the canonical repo URL (incl. raw/CDN forms) is not personal data
const REPO_URL = /(?:raw\.githubusercontent\.com|github\.com)\/jagritvats\/autohire/g;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];
for (const f of files) {
  if (ALLOW.has(f)) continue;
  if (/^apps\/web\/uploads\//.test(f) || /\/uploads\/.+\.(pdf|docx?)$/i.test(f)) {
    hits.push(`${f}: user upload committed`);
    continue;
  }
  if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|lock)$/i.test(f) || f.endsWith("pnpm-lock.yaml")) continue;
  let text;
  try {
    text = readFileSync(f, "utf8").replace(REPO_URL, "");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const re of DENY) if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
if (hits.length) {
  console.error(`check-pii: ${hits.length} possible personal-data hit(s):\n` + hits.join("\n"));
  process.exit(1);
}
console.log(`check-pii: ${files.length} tracked files clean`);
