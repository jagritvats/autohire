import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { authMode, withAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Who am I — the UI uses it for the account menu; the CLI uses it to verify a token. */
export const GET = withAuth(async (_req, auth) => {
  const repo = await getRepo();
  const user = auth.userId ? await repo.getUser(auth.userId) : null;
  return NextResponse.json({
    mode: authMode(),
    tenantId: auth.tenantId,
    via: auth.via,
    role: auth.role,
    scopes: [...auth.scopes],
    email: user?.email ?? null,
  });
});
