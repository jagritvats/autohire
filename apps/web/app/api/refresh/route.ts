import { NextResponse } from "next/server";
import { refreshFeed } from "@/lib/feed";

// Force a fresh poll of the live ATS/aggregator sources (Tier 1-2 only) + re-rank.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const data = await refreshFeed();
  return NextResponse.json(data);
}
