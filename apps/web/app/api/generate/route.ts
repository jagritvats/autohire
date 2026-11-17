import { NextResponse } from "next/server";
import { z } from "zod";
import { GenerationKind } from "@jobflow/core";
import { generateTailored, listTailored, clearTailored, saveEditedDraft } from "@/lib/tailor";
import { guard } from "@/lib/auth";

// Generation can call a real LLM — a full LaTeX résumé can take a couple of minutes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DraftKind = GenerationKind.exclude(["rerank"]); // the ranker's cached write-up isn't a draft

/** ProviderError carries a friendly userMessage + raw detail (§ retries/progress). */
function errorResponse(e: unknown) {
  const pe = e as Error & { userMessage?: string; detail?: string; status?: number };
  return NextResponse.json({ error: pe.userMessage ?? pe.message, detail: pe.detail }, { status: pe.status && pe.status < 500 ? pe.status : 502 });
}

/** Cached drafts for a posting (?postingId=) or the generic settings drafts (?postingId=null). */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const raw = url.searchParams.get("postingId");
  const postingId = raw === null ? undefined : raw === "null" || raw === "" ? null : raw;
  const drafts = await listTailored(auth.tenantId, postingId);
  return NextResponse.json({ drafts });
}

const Body = z.object({
  postingId: z.string().uuid().nullable().optional(),
  kind: DraftKind,
  question: z.string().optional(),
  note: z.string().max(4000).optional(),
  force: z.boolean().optional(),
});

/** Generate (or return cached) a draft. Grounded + honest-voice (invariant #3). */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  try {
    return NextResponse.json(await generateTailored(auth.tenantId, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}

const Edit = z.object({
  postingId: z.string().uuid().nullable(),
  kind: DraftKind,
  question: z.string().optional(),
  text: z.string().max(200_000),
});

/** Save the user's edit of an existing draft (kept until regenerated). */
export async function PATCH(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Edit.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  try {
    return NextResponse.json(await saveEditedDraft(auth.tenantId, parsed.data));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Force-refresh: clear cached drafts (all, or ?postingId= for one posting). */
export async function DELETE(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const raw = url.searchParams.get("postingId");
  const postingId = raw === null ? undefined : raw === "null" || raw === "" ? null : raw;
  const cleared = await clearTailored(auth.tenantId, postingId);
  return NextResponse.json({ cleared });
}
