import "server-only";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { TokenScope } from "@jobflow/core";
import { getRepo } from "../repo";
import { authMode, isFailure, resolveAuth, type AuthContext } from "./resolve";

export type { AuthContext } from "./resolve";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export interface Need {
  /** a token must carry this scope (sessions carry all scopes). */
  scope?: TokenScope;
  /** admin-only (instance-wide actions: global polls, purges, the shared registry). */
  admin?: boolean;
}

function check(ctx: AuthContext, need: Need): AuthContext {
  if (need.scope && !ctx.scopes.has(need.scope)) throw new AuthError(`This token lacks the "${need.scope}" scope.`, 403);
  if (need.admin && ctx.role !== "admin") throw new AuthError("Only an admin can do that on a shared instance.", 403);
  return ctx;
}

function requestHost(req: Request): string | null {
  // behind your own reverse proxy, trust X-Forwarded-Host only when told to
  const fwd = process.env.JOBFLOW_TRUST_PROXY === "1" ? req.headers.get("x-forwarded-host") : null;
  return fwd ?? req.headers.get("host");
}

/** Resolve the caller of an API request or throw AuthError (401/403). Every route calls this. */
export async function requireAuth(req: Request, need: Need = {}): Promise<AuthContext> {
  const repo = await getRepo();
  const r = await resolveAuth(repo, {
    mode: authMode(),
    method: req.method,
    url: req.url,
    host: requestHost(req),
    origin: req.headers.get("origin"),
    cookie: req.headers.get("cookie"),
    authorization: req.headers.get("authorization"),
    trustNetwork: process.env.JOBFLOW_TRUST_NETWORK === "1",
  });
  if (isFailure(r)) throw new AuthError(r.error, r.status);
  return check(r, need);
}

type Handler<C> = (req: Request, auth: AuthContext, ctx: C) => Promise<Response> | Response;

/** Wrap a route handler: resolves auth first and maps AuthError → JSON 401/403. */
export function withAuth<C = unknown>(handler: Handler<C>, need: Need = {}): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const auth = await requireAuth(req, need);
      return await handler(req, auth, ctx);
    } catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  };
}

/** Resolve the viewer of a server-rendered page; redirects to /login in password mode. */
export async function pageAuth(nextPath = "/"): Promise<AuthContext> {
  const repo = await getRepo();
  const h = await headers();
  const fwd = process.env.JOBFLOW_TRUST_PROXY === "1" ? h.get("x-forwarded-host") : null;
  const r = await resolveAuth(repo, {
    mode: authMode(),
    method: "GET",
    url: nextPath,
    host: fwd ?? h.get("host"),
    origin: null,
    cookie: (await cookies()).toString(),
    authorization: null,
    trustNetwork: process.env.JOBFLOW_TRUST_NETWORK === "1",
  });
  if (isFailure(r)) {
    if (authMode() === "password") redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    throw new Error(r.error);
  }
  return r;
}

/**
 * One-line route guard: `const auth = await guard(req); if (auth instanceof Response) return auth;`
 * Returns the caller, or a JSON 401/403 response to return as-is.
 */
export async function guard(req: Request, need: Need = {}): Promise<AuthContext | Response> {
  try {
    return await requireAuth(req, need);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
