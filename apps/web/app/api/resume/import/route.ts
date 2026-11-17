import { NextResponse } from "next/server";
import { ImportError, importResume } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Parse a résumé into a DRAFT for review (onboarding step 1). Accepts multipart `file`
 * (PDF, DOCX, .tex, .md, .txt, JSON Resume, LinkedIn export .zip/.csv) or JSON `{ text }`.
 * `?assist=1` also runs the grounded LLM extraction with your model. Nothing is written to
 * your profile here — you confirm the draft first.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const assist = new URL(req.url).searchParams.get("assist") === "1";
  try {
    const repo = await getRepo();
    let result;
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
      result = await importResume(repo, getFileStore(), auth.tenantId, {
        file: { filename: file.name || "resume", mime: file.type || undefined, bytes: new Uint8Array(await file.arrayBuffer()) },
        assist,
      });
    } else {
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      result = await importResume(repo, getFileStore(), auth.tenantId, { text: body.text ?? "", assist });
    }
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
