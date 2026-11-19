#!/usr/bin/env node
// Fails if tracked files contain markers of real personal data (a résumé, the original
// author's identity, personal projects) — the regression guard for the open-source scrub.
// Fixtures must use fictional people at example.com.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Generic markers of a real person's files.
const DENY = [/Resume_\d+_/i, /@gmail\.com/i];
// Identifiers of the original author (name, email user, personal projects) are kept only as
// salted SHA-256 prefixes, so this guard blocks them without publishing them. A line is
// flagged when any word, any word's first six letters, or any two-word phrase matches.
// To add one: node -e 'console.log(require("crypto").createHash("sha256").update("jobflow-pii:"+process.argv[1].toLowerCase()).digest("hex").slice(0,16))' "<word or two words>"
const DENY_HASHES = new Set(["1f24b2c2670fc0d0", "c3c30eeaa292d881", "0aab608df7acbdc8", "97ddd95e20e5ccdc"]);
const hash = (s) => createHash("sha256").update("jobflow-pii:" + s.toLowerCase()).digest("hex").slice(0, 16);
function hashedHit(line) {
  const words = line.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (DENY_HASHES.has(hash(w)) || (w.length > 6 && DENY_HASHES.has(hash(w.slice(0, 6))))) return true;
    if (i > 0 && DENY_HASHES.has(hash(`${words[i - 1]} ${w}`))) return true;
  }
  return false;
}
// files allowed to mention the generic patterns (this script and the publishing guide)
const ALLOW = new Set(["scripts/check-pii.mjs", "docs/internal/PUBLISHING.md"]);
// the canonical repo URL (incl. raw/CDN forms) is not personal data
const REPO_URL = /(?:raw\.githubusercontent\.com|github\.com)\/jagritvats\/(?:jobflow|autohire)/g;

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
    if (DENY.some((re) => re.test(line)) || hashedHit(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
if (hits.length) {
  console.error(`check-pii: ${hits.length} possible personal-data hit(s):\n` + hits.join("\n"));
  process.exit(1);
}
console.log(`check-pii: ${files.length} tracked files clean`);
