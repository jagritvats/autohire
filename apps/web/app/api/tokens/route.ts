import { NextResponse } from "next/server";
import { z } from "zod";
import { TokenScope } from "@jobflow/core";
import { getRepo } from "@/lib/repo";
import { withAuth } from "@/lib/auth";
import { issueApiToken } from "@/lib/auth/tokens";

export const dynamic = "force-dynamic";

/** Your API tokens (CLI / browser extension / local agent) — metadata only, never secrets. */
export const GET = withAuth(async (_req, auth) => {
  const repo = await getRepo();
  return NextResponse.json({ tokens: await repo.listApiTokens(auth.tenantId) });
});

const Create = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(TokenScope).min(1),
  expiresDays: z.number().int().positive().max(3650).nullable().optional(),
});

/** Create a token. The plaintext is in this response ONLY — it's stored as a hash. */
export const POST = withAuth(async (req, auth) => {
  // a token can't mint more tokens: only a signed-in person (or the single-user owner) can
  if (auth.via === "token") return NextResponse.json({ error: "Create tokens from the web app while signed in." }, { status: 403 });
  const parsed = Create.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Give the token a name and at least one scope." }, { status: 400 });
  const repo = await getRepo();
  const { token, meta } = await issueApiToken(repo, auth, parsed.data);
  return NextResponse.json({ token, meta });
});

/** Revoke a token (?id=). */
export const DELETE = withAuth(async (req, auth) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  const repo = await getRepo();
  const ok = await repo.revokeApiToken(auth.tenantId, id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
});
