import "server-only";
import { randomBytes } from "node:crypto";
import type { Repository } from "@jobflow/db";
import type { User } from "@jobflow/core";
import { SESSION_COOKIE, SESSION_TTL_MS, readCookie, sha256Hex } from "./resolve";

const b64url = (n: number) => randomBytes(n).toString("base64url");

function secureFlag(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto");
  const publicUrl = process.env.JOBFLOW_PUBLIC_URL ?? "";
  return proto === "https" || publicUrl.startsWith("https://") || req.url.startsWith("https://") ? "; Secure" : "";
}

/** Mint a fresh session (new id on every login — no fixation) and return its Set-Cookie value. */
export async function issueSession(repo: Repository, user: User, req: Request): Promise<string> {
  const id = b64url(12);
  const secret = b64url(32);
  const now = new Date();
  await repo.createSession({
    id,
    userId: user.id,
    tenantId: user.tenantId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    secretHash: sha256Hex(secret),
  });
  await repo.touchTenantActive(user.tenantId).catch(() => undefined);
  return `${SESSION_COOKIE}=${id}.${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secureFlag(req)}`;
}

/** Delete the caller's session row and return a Set-Cookie that clears the cookie. */
export async function clearSession(repo: Repository, req: Request): Promise<string> {
  const raw = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const id = raw?.split(".")[0];
  if (id) await repo.deleteSession(id).catch(() => undefined);
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`;
}
