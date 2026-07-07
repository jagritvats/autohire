import { NextResponse } from "next/server";
import { purgeOldFeed } from "@/lib/feed";

export const dynamic = "force-dynamic";

/**
 * Remove older entries. Body: `{ olderThanDays, field?: 'lastSeen'|'firstSeen', hard? }`.
 * Soft-deletes (marks stale) by default; `hard: true` deletes the rows. Invalidated
 * postings are never touched (a manual decision outranks age).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const olderThanDays = Number(body?.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    return NextResponse.json({ error: "olderThanDays must be a positive number" }, { status: 400 });
  }
  const field = body?.field === "firstSeen" ? "firstSeen" : "lastSeen";
  const data = await purgeOldFeed({ olderThanDays, field, hard: !!body?.hard });
  return NextResponse.json(data);
}
