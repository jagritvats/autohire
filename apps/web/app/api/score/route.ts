import { NextResponse } from "next/server";
import { z } from "zod";
import { isAllowedOrigin, scorePage } from "@/lib/extension";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(500),
  jdText: z.string().max(40_000),
  company: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
});

/** Browser extension: score the posting on the page you're viewing (§7.1 layer 1). */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) return NextResponse.json({ error: "origin not allowed" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  return NextResponse.json(await scorePage(parsed.data));
}
