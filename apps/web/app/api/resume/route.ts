import { NextResponse } from "next/server";
import { blankProfile } from "@jobflow/pipeline";
import type { Profile } from "@jobflow/core";
import { ImportError, importResume } from "@jobflow/service";
import { getRepo, ensureTenant } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { guard } from "@/lib/auth";

// pdf-parse + filesystem need the node runtime, not the edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replace your base résumé from Settings (PDF / DOCX / .tex / .md / .txt / JSON Resume).
 * The extracted text becomes `profile.masterResume` (what generation grounds on); the file
 * is stored in YOUR data dir (never the source tree) and `contact.resumePath` points at it
 * so the local form-filler can attach the real file. A .tex is also kept raw in
 * `profile.resumeLatex` — the template the tailor rewrites. Stack, evidence and preferences
 * are left alone here; use onboarding to review and import those.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });

  const repo = await getRepo();
  const files = getFileStore();
  let draft, stored;
  try {
    ({ draft, file: stored } = await importResume(repo, files, auth.tenantId, {
      file: { filename: file.name || "resume", mime: file.type || undefined, bytes: new Uint8Array(await file.arrayBuffer()) },
    }));
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const text = draft.text;
  const latex = draft.latex;
  const resumePath = stored ? ((await files.localPath(stored.key)) ?? "") : "";

  await ensureTenant(repo, auth.tenantId);
  const current = (await repo.getProfile(auth.tenantId)) ?? blankProfile(auth.tenantId);
  const next: Profile = {
    ...current,
    masterResume: text,
    // keep the raw .tex when a LaTeX résumé is imported (the tailor template)
    resumeLatex: latex || current.resumeLatex,
    resumeFile: stored ?? current.resumeFile,
    // resume changed → drop the cached embedding so the next rank re-embeds
    profileEmbedding: null,
    prefs: {
      ...current.prefs,
      contact: { ...current.prefs.contact, resumePath: resumePath || current.prefs.contact.resumePath },
    },
  };
  await repo.saveProfile(next);

  // a PDF/text upload doesn't touch the LaTeX template — say so, since LaTeX tailoring
  // keeps rewriting that older .tex until it's replaced or cleared
  const latexKept = !latex && !!current.resumeLatex.trim();
  return NextResponse.json({
    text,
    fileName: file.name,
    resumePath,
    chars: text.length,
    isLatex: !!latex,
    latex,
    latexKept,
    warnings: draft.warnings,
  });
}
