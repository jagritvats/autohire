import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@jobflow/db";
import { getRepo } from "@/lib/repo";
import { withAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const Body = z.object({ current: z.string().max(200), next: z.string().min(10).max(200) });

/** Change your password; every OTHER session of yours is signed out. */
export const POST = withAuth(async (req, auth) => {
  if (auth.via !== "session" || !auth.userId) return NextResponse.json({ error: "Sign in with your password to change it." }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "The new password needs at least 10 characters." }, { status: 400 });
  const repo = await getRepo();
  const user = await repo.getUser(auth.userId);
  const full = user ? await repo.findUserByEmail(user.email) : null;
  if (!full || !(await verifyPassword(parsed.data.current, full.passwordHash))) {
    return NextResponse.json({ error: "Your current password is wrong." }, { status: 401 });
  }
  await repo.setUserPassword(full.id, await hashPassword(parsed.data.next));
  const revoked = await repo.deleteUserSessions(full.id, auth.sessionId);
  return NextResponse.json({ ok: true, signedOutSessions: revoked });
});
