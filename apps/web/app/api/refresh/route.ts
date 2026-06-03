import { NextResponse } from "next/server";
import { getFeed } from "@/lib/feed";

// Force a fresh poll of the live ATS/aggregator sources (Tier 1-2 only).
export const dynamic = "force-dynamic";

export async function POST() {
  const data = await getFeed(true);
  return NextResponse.json(data);
}
