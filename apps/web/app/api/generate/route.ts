import { NextResponse } from "next/server";
import { z } from "zod";
import { GenerationKind } from "@jobflow/core";
import { generateTailored, listTailored, clearTailored } from "@/lib/tailor";

// Generation can call a real LLM — give it room and a node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Cached drafts for a posting (?postingId=) or the generic settings drafts (?postingId=null). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("postingId");
  const postingId = raw === null ? undefined : raw === "null" || raw === "" ? null : raw;
  const drafts = await listTailored(postingId);
  return NextResponse.json({ drafts });
}

const Body = z.object({
  postingId: z.string().uuid().nullable().optional(),
  kind: GenerationKind,
  question: z.string().optional(),
  force: z.boolean().optional(),
});

/** Generate (or return cached) a draft. Evidence-grounded + honest-voice (invariant #3). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  try {
    const draft = await generateTailored(parsed.data);
    return NextResponse.json(draft);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Force-refresh: clear cached drafts (all, or ?postingId= for one posting). */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("postingId");
  const postingId = raw === null ? undefined : raw === "null" || raw === "" ? null : raw;
  const cleared = await clearTailored(postingId);
  return NextResponse.json({ cleared });
}
