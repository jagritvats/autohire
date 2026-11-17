import { NextResponse } from "next/server";
import { SignupInput } from "@jobflow/core";
import { hashPassword } from "@jobflow/db";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { ensureTenant } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { authMode } from "@/lib/auth";
import { issueSession } from "@/lib/auth/session";
import { clientKey, rateLimited } from "@/lib/auth/ratelimit";
import { originAllowed } from "@/lib/auth/resolve";

export const dynamic = "force-dynamic";

/**
 * Create an account (JOBFLOW_AUTH=password). The FIRST account becomes the admin and claims
 * the default tenant, so a single-user install that turns on accounts keeps its data. Later
 * signups get a fresh, blank tenant — and only when JOBFLOW_SIGNUP=open.
 */
export async function POST(req: Request) {
  if (authMode() !== "password") {
    return NextResponse.json({ error: "Accounts are off (JOBFLOW_AUTH=none): this is a single-user install." }, { status: 400 });
  }
  if (!originAllowed({ method: "POST", origin: req.headers.get("origin"), host: req.headers.get("host") }, false)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  if (rateLimited(`signup:${clientKey(req)}`, 5)) return NextResponse.json({ error: "Too many attempts — wait a minute." }, { status: 429 });
  const parsed = SignupInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email and a password of at least 10 characters." }, { status: 400 });

  const repo = await getRepo();
  const first = (await repo.countUsers()) === 0;
  if (!first && process.env.JOBFLOW_SIGNUP !== "open") {
    return NextResponse.json({ error: "Sign-ups are closed on this instance. Ask the admin for an account." }, { status: 403 });
  }
  if (await repo.findUserByEmail(parsed.data.email)) {
    return NextResponse.json({ error: "That email already has an account — sign in instead." }, { status: 409 });
  }
  const tenant = first
    ? await repo.createTenant({ id: DEFAULT_TENANT, name: parsed.data.email })
    : await repo.createTenant({ name: parsed.data.email });
  const user = await repo.createUser({
    tenantId: tenant.id,
    email: parsed.data.email,
    passwordHash: await hashPassword(parsed.data.password),
    role: first ? "admin" : "member",
  });
  await ensureTenant(repo, tenant.id);
  const cookie = await issueSession(repo, user, req);
  return NextResponse.json({ user: { email: user.email, role: user.role } }, { headers: { "set-cookie": cookie } });
}
