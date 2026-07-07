import { NextResponse } from "next/server";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { getRepo } from "@/lib/repo";

export const dynamic = "force-dynamic";

/** Archive a posting for this tenant — retained but hidden from the active feed. */
export async function POST(req: Request) {
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingArchived(DEFAULT_TENANT, postingId, true);
  return NextResponse.json({ ok: true });
}

/** Unarchive → back in the feed. */
export async function DELETE(req: Request) {
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.setPostingArchived(DEFAULT_TENANT, postingId, false);
  return NextResponse.json({ ok: true });
}
