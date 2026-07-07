import { NextResponse } from "next/server";
import { z } from "zod";
import { generateTailored } from "@/lib/tailor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Body = z.object({ postingId: z.string().uuid(), force: z.boolean().optional() });

/** Generate (or return cached) the tailored LaTeX résumé for a posting. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  try {
    const draft = await generateTailored({ postingId: parsed.data.postingId, kind: "resume_latex", force: parsed.data.force });
    return NextResponse.json({ latex: draft.text, model: draft.model, cached: draft.cached });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
