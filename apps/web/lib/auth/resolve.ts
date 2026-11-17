import { createHash, timingSafeEqual } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { parseApiToken, type AuthMode, type TokenScope, type UserRole } from "@jobflow/core";
import { DEFAULT_TENANT } from "@jobflow/pipeline";

/**
 * Who is calling, resolved once per request (per-user capability). PURE of Next.js so it
 * is unit-testable: route handlers adapt a Request into `AuthInput`.
 *
 * - `none` (default): a single-user localhost tool. Every request is the default tenant,
 *   but ONLY from a loopback Host (blocks DNS rebinding) and, for state changes, from the
 *   app's own origin or the extension (blocks cross-site requests from any web page).
 * - `password`: multi-user. A session cookie (`jf_session=<id>.<secret>`) or a bearer API
 *   token (`jft_<id>.<secret>`) identifies the tenant; only sha256(secret) is stored.
 */
export interface AuthContext {
  tenantId: string;
  userId: string | null;
  role: UserRole;
  via: "none" | "session" | "token";
  scopes: Set<TokenScope>;
  tokenId?: string;
  sessionId?: string;
}

export interface AuthFailure {
  error: string;
  status: 401 | 403;
}

export interface AuthInput {
  mode: AuthMode;
  method: string;
  url: string;
  host: string | null;
  origin: string | null;
  cookie: string | null;
  authorization: string | null;
  /** JOBFLOW_TRUST_NETWORK=1: allow non-loopback hosts in `none` mode (behind your own proxy). */
  trustNetwork?: boolean;
}

export const SESSION_COOKIE = "jf_session";
export const SESSION_TTL_MS = 30 * 86_400_000;
const ALL_SCOPES: TokenScope[] = ["extension", "agent", "cli"];

export function authMode(): AuthMode {
  return process.env.JOBFLOW_AUTH === "password" ? "password" : "none";
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function hostname(host: string | null): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0]!.toLowerCase();
}

export function isLoopbackHost(host: string | null): boolean {
  const h = hostname(host);
  return LOOPBACK.has(h) || h.endsWith(".localhost");
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Same-origin check for state-changing requests. Browsers always send Origin on
 * cross-origin POST/PUT/DELETE (incl. `text/plain` "simple" requests that skip preflight),
 * so a mismatched Origin is a cross-site request. No Origin = not a browser (curl, CLI).
 */
export function originAllowed(input: Pick<AuthInput, "method" | "origin" | "host">, allowExtension: boolean): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;
  const origin = input.origin;
  if (!origin || origin === "null") return origin !== "null";
  if (allowExtension && (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://"))) return true;
  try {
    return new URL(origin).host.toLowerCase() === (input.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function fromToken(repo: Repository, authorization: string): Promise<AuthContext | AuthFailure> {
  const parsed = parseApiToken(authorization);
  if (!parsed) return { error: "Malformed API token.", status: 401 };
  const tok = await repo.getApiToken(parsed.id);
  if (!tok || tok.revokedAt || !safeEqualHex(sha256Hex(parsed.secret), tok.secretHash)) {
    return { error: "Invalid or revoked API token.", status: 401 };
  }
  if (tok.expiresAt && new Date(tok.expiresAt as string | Date).getTime() < Date.now()) {
    return { error: "API token expired.", status: 401 };
  }
  const last = tok.lastUsedAt ? new Date(tok.lastUsedAt as string | Date).getTime() : 0;
  if (Date.now() - last > 5 * 60_000) void repo.touchApiToken(tok.id).catch(() => undefined);
  const user = tok.userId ? await repo.getUser(tok.userId) : null;
  if (user?.disabledAt) return { error: "Account disabled.", status: 403 };
  return {
    tenantId: tok.tenantId,
    userId: tok.userId,
    role: user?.role ?? "member",
    via: "token",
    scopes: new Set(tok.scopes),
    tokenId: tok.id,
  };
}

async function fromSession(repo: Repository, raw: string): Promise<AuthContext | AuthFailure> {
  const dot = raw.indexOf(".");
  if (dot <= 0) return { error: "Not signed in.", status: 401 };
  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  const s = await repo.getSession(id);
  if (!s || !safeEqualHex(sha256Hex(secret), s.secretHash)) return { error: "Not signed in.", status: 401 };
  if (new Date(s.expiresAt as string | Date).getTime() < Date.now()) return { error: "Session expired.", status: 401 };
  const user = await repo.getUser(s.userId);
  if (!user || user.disabledAt) return { error: "Account disabled.", status: 403 };
  // sliding expiry, written at most hourly
  if (Date.now() - new Date(s.lastSeenAt as string | Date).getTime() > 3_600_000) {
    void repo.touchSession(s.id, new Date(Date.now() + SESSION_TTL_MS)).catch(() => undefined);
    void repo.touchTenantActive(s.tenantId).catch(() => undefined);
  }
  return { tenantId: s.tenantId, userId: s.userId, role: user.role, via: "session", scopes: new Set(ALL_SCOPES), sessionId: s.id };
}

export async function resolveAuth(repo: Repository, input: AuthInput): Promise<AuthContext | AuthFailure> {
  const bearer = input.authorization && /^Bearer\s+/i.test(input.authorization) ? input.authorization : null;

  if (input.mode === "none") {
    if (!input.trustNetwork && !isLoopbackHost(input.host)) {
      return {
        error: "JobFlow is running in single-user mode (JOBFLOW_AUTH=none) and only answers on localhost. " +
          "Set JOBFLOW_AUTH=password to serve it on a network.",
        status: 403,
      };
    }
    if (bearer) {
      const t = await fromToken(repo, bearer);
      if (!("error" in t)) return t;
    }
    if (!originAllowed(input, true)) return { error: "Cross-site request refused.", status: 403 };
    return { tenantId: DEFAULT_TENANT, userId: null, role: "admin", via: "none", scopes: new Set(ALL_SCOPES) };
  }

  // password mode — a bearer token needs no CSRF check (browsers never attach it on their own)
  if (bearer) return fromToken(repo, bearer);
  const raw = readCookie(input.cookie, SESSION_COOKIE);
  if (!raw) return { error: "Not signed in.", status: 401 };
  const ctx = await fromSession(repo, raw);
  if ("error" in ctx) return ctx;
  if (!originAllowed(input, false)) return { error: "Cross-site request refused.", status: 403 };
  return ctx;
}

export function isFailure(x: AuthContext | AuthFailure): x is AuthFailure {
  return "error" in x;
}
