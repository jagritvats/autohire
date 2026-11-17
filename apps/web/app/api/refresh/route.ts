import { NextResponse } from "next/server";
import { refreshFeed, rerankOnly } from "@/lib/feed";
import { guard } from "@/lib/auth";

// Force a fresh poll of the live ATS/aggregator sources (Tier 1-2 only) + re-rank.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  // re-polling the shared corpus is an admin action on a multi-user instance; members re-rank
  const data = auth.role === "admin" ? await refreshFeed(auth.tenantId) : await rerankOnly(auth.tenantId);
  return NextResponse.json(data);
}
