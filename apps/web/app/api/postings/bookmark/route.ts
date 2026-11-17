import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Bookmark a posting for this tenant. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingBookmarked(auth.tenantId, postingId, true);
  return NextResponse.json({ ok: true });
}

/** Remove a bookmark. */
export async function DELETE(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingBookmarked(auth.tenantId, postingId, false);
  return NextResponse.json({ ok: true });
}
