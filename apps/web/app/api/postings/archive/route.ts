import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Archive a posting for this tenant — retained but hidden from the active feed. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingArchived(auth.tenantId, postingId, true);
  return NextResponse.json({ ok: true });
}

/** Unarchive → back in the feed. */
export async function DELETE(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingArchived(auth.tenantId, postingId, false);
  return NextResponse.json({ ok: true });
}
