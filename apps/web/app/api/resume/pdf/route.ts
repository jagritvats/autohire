import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import type { Profile } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";
import { generateTailored } from "@/lib/tailor";
import { compileLatex } from "@/lib/latex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UPLOAD_DIR = join(process.cwd(), "uploads");
const Body = z.object({
  postingId: z.string().uuid(),
  latex: z.string().optional(), // optional override (e.g. user-edited .tex)
  save: z.boolean().optional(), // also store the PDF + point the autofill attachment at it
  force: z.boolean().optional(),
});

/**
 * Compile the tailored LaTeX résumé to PDF on this machine and stream it back. On
 * compile failure (or no engine) we return JSON with the log + the .tex so the UI can
 * offer a .tex download (Overleaf). `save:true` persists the PDF and sets
 * `contact.resumePath` so the local agent attaches the *tailored* résumé.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { postingId, save, force } = parsed.data;

  let latex = parsed.data.latex;
  if (!latex) {
    try {
      const draft = await generateTailored({ postingId, kind: "resume_latex", force });
      latex = draft.text;
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const result = await compileLatex(latex);
  if (!result.pdf) {
    return NextResponse.json(
      { ok: false, error: result.error, log: result.log, noEngine: result.noEngine, latex },
      { status: result.noEngine ? 501 : 422 },
    );
  }

  if (save) {
    try {
      await mkdir(UPLOAD_DIR, { recursive: true });
      const path = join(UPLOAD_DIR, `${Date.now()}-tailored-${postingId.slice(0, 8)}.pdf`);
      await writeFile(path, result.pdf);
      const repo = await getRepo();
      await ensureTenant(repo);
      const current = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
      const next: Profile = { ...current, prefs: { ...current.prefs, contact: { ...current.prefs.contact, resumePath: path } } };
      await repo.saveProfile(next);
    } catch {
      /* best-effort; the PDF still streams back */
    }
  }

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="tailored-resume.pdf"`,
      "x-latex-engine": result.engine ?? "",
    },
  });
}
