import { NextResponse } from "next/server";
import { z } from "zod";
import { capturePage, isAllowedOrigin } from "@/lib/extension";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(500),
  jdText: z.string().min(1).max(40_000),
  company: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
});

/** Browser extension: save the posting you're viewing into the feed (bookmarked). */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) return NextResponse.json({ error: "origin not allowed" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  return NextResponse.json(await capturePage(parsed.data));
}
