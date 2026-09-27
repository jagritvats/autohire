import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import type { Application } from "@jobflow/core";
import { candidateName, markdownToLatex } from "@jobflow/llm";
import { getRepo, ensureTenant } from "@/lib/repo";
import { generateTailored } from "@/lib/tailor";
import { compileLatex } from "@/lib/latex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UPLOAD_DIR = join(process.cwd(), "uploads");
const Body = z.object({
  postingId: z.string().uuid(),
  latex: z.string().max(200_000).optional(), // the (possibly user-edited) .tex to compile
  markdown: z.string().max(200_000).optional(), // or a Markdown résumé → typeset via the built-in template
  save: z.boolean().optional(), // also store the PDF + point this application's attachment at it
  force: z.boolean().optional(),
});

/**
 * Compile a tailored résumé to PDF on this machine and stream it back (the tailor page
 * previews it inline). The source is, in order: the posted `latex`, the posted `markdown`
 * (converted on the built-in template), or the cached/generated LaTeX draft. On compile
 * failure (or no engine) we return JSON with the log + the .tex so the UI can offer a
 * .tex download (Overleaf). `save:true` persists the PDF as this application's attachment.
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { postingId, save, force } = parsed.data;

  let latex = parsed.data.latex ?? (parsed.data.markdown !== undefined ? markdownToLatex(parsed.data.markdown) : undefined);
  if (!latex) {
    try {
      latex = (await generateTailored({ postingId, kind: "resume_latex", force })).text;
    } catch (e) {
      const pe = e as Error & { userMessage?: string; detail?: string };
      return NextResponse.json({ error: pe.userMessage ?? pe.message, detail: pe.detail }, { status: 400 });
    }
  }

  const result = await compileLatex(latex);
  if (!result.pdf) {
    return NextResponse.json(
      { ok: false, error: result.error, log: result.log, noEngine: result.noEngine, latex },
      { status: result.noEngine ? 501 : 422 },
    );
  }

  let saved = "";
  if (save) {
    try {
      const repo = await getRepo();
      await ensureTenant(repo);
      // the ATS shows the uploaded file's name to the recruiter — make it a normal one
      const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
      const who = candidateName(profile).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
      const dir = join(UPLOAD_DIR, "tailored", postingId);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${who ? `${who}_` : ""}Resume.pdf`);
      await writeFile(path, result.pdf);
      // attach to THIS application (not the global profile) so tailoring role B doesn't
      // clobber role A's attachment; the agent prefers this over the base résumé.
      const existing = await repo.getApplicationByPosting(DEFAULT_TENANT, postingId);
      const app: Application = existing ?? {
        id: randomUUID(), tenantId: DEFAULT_TENANT, postingId, status: "drafting",
        appliedVia: null, tailoredResumeUrl: null, resumeVariant: null, answers: {},
        submittedAt: null, nextAction: null, nextActionAt: null, outcome: null,
      };
      await repo.upsertApplication({ ...app, tailoredResumeUrl: path });
      saved = path;
    } catch {
      /* best-effort; the PDF still streams back, and the header says it wasn't attached */
    }
  }

  return new NextResponse(new Uint8Array(result.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="resume.pdf"`,
      "x-latex-engine": result.engine ?? "",
      "x-saved": saved ? "1" : "",
    },
  });
}
