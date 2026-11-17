#!/usr/bin/env node
// Tenant-isolation guard (per-user capability). Fails when:
//  - an API route doesn't resolve its caller (guard / withAuth / requireAuth), or
//  - web code reaches for the hard-coded default tenant instead of the caller's tenant.
// Public auth endpoints (signup/login/logout) are the only routes allowed without a caller.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "apps/web");
const PUBLIC_ROUTES = new Set(["app/api/auth/signup/route.ts", "app/api/auth/login/route.ts", "app/api/auth/logout/route.ts"]);
const TENANT_CONSTANT_OK = new Set(["lib/auth/resolve.ts", "app/api/auth/signup/route.ts"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(join(WEB, "app")).concat(walk(join(WEB, "lib")))) {
  const rel = relative(WEB, file);
  const src = readFileSync(file, "utf8");
  if (rel.endsWith("route.ts") && rel.startsWith("app/api/") && !PUBLIC_ROUTES.has(rel)) {
    if (!/\b(guard|withAuth|requireAuth)\(/.test(src)) problems.push(`${rel}: API route never resolves its caller (use guard/withAuth)`);
  }
  if (!TENANT_CONSTANT_OK.has(rel) && /\bDEFAULT_TENANT\b/.test(src)) {
    problems.push(`${rel}: uses DEFAULT_TENANT — use the caller's auth.tenantId`);
  }
}
if (problems.length) {
  console.error(`check-tenant: ${problems.length} problem(s):\n` + problems.join("\n"));
  process.exit(1);
}
console.log("check-tenant: every API route resolves its caller; no hard-coded tenant in web code");
