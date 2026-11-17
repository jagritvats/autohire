import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Manually mark a posting invalid (spam/dupe/fake) with a reason — excluded from the feed. */
export async function POST(req: Request) {
  const auth = await guard(req, { admin: true });
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId, reason } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.invalidatePosting(postingId, typeof reason === "string" && reason.trim() ? reason.trim() : "marked invalid");
  return NextResponse.json({ ok: true });
}

/** Reverse an invalidation → back to active (idempotent). */
export async function DELETE(req: Request) {
  const auth = await guard(req, { admin: true });
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  const { postingId } = await req.json();
  if (!postingId) return NextResponse.json({ error: "postingId required" }, { status: 400 });
  await repo.revalidatePosting(postingId);
  return NextResponse.json({ ok: true });
}
