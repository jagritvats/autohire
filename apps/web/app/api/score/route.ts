import { NextResponse } from "next/server";
import { z } from "zod";
import { scorePage } from "@/lib/extension";
import { guard } from "@/lib/auth";

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
  const auth = await guard(req, { scope: "extension" });
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  return NextResponse.json(await scorePage(auth.tenantId, parsed.data));
}
