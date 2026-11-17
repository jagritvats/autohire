import { NextResponse } from "next/server";
import { LoginInput } from "@jobflow/core";
import { verifyPassword } from "@jobflow/db";
import { getRepo } from "@/lib/repo";
import { authMode } from "@/lib/auth";
import { issueSession } from "@/lib/auth/session";
import { clientKey, rateLimited } from "@/lib/auth/ratelimit";
import { originAllowed } from "@/lib/auth/resolve";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (authMode() !== "password") return NextResponse.json({ error: "Accounts are off (JOBFLOW_AUTH=none)." }, { status: 400 });
  if (!originAllowed({ method: "POST", origin: req.headers.get("origin"), host: req.headers.get("host") }, false)) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  const parsed = LoginInput.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  const email = parsed.data.email.trim().toLowerCase();
  if (rateLimited(`login:${clientKey(req)}`, 20) || rateLimited(`login:${email}`, 8)) {
    return NextResponse.json({ error: "Too many attempts — wait a minute." }, { status: 429 });
  }
  const repo = await getRepo();
  const found = await repo.findUserByEmail(email);
  // verify even when the user is missing so timing doesn't reveal which emails exist
  const ok = await verifyPassword(parsed.data.password, found?.passwordHash ?? null);
  if (!found || !ok || found.disabledAt) return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  const { passwordHash: _h, ...user } = found;
  const cookie = await issueSession(repo, user, req);
  return NextResponse.json({ user: { email: user.email, role: user.role } }, { headers: { "set-cookie": cookie } });
}
