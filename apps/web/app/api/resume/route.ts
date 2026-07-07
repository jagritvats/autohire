import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import { latexToText, type Profile } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";

// pdf-parse + filesystem need the node runtime, not the edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_DIR = join(process.cwd(), "uploads");

/**
 * Upload a base resume (PDF / .txt / .md / .tex). We extract the text into
 * `profile.masterResume` (what generation grounds on) and store the file, pointing
 * `contact.resumePath` at it so the local autofill agent can attach the real file
 * later (§7.1). A .tex is also kept raw in `profile.resumeLatex` — the template the
 * tailor rewrites. Only stored values are ever used; nothing here submits anything.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const name = file.name || "resume";
  const lower = name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  let text: string;
  let latex = ""; // raw .tex when a LaTeX résumé is imported
  try {
    if (lower.endsWith(".pdf") || file.type === "application/pdf") {
      // import the lib path directly — the package's index.js runs a debug shim
      // that reads a bundled test PDF when required as the main module.
      const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
      const parsed = await pdfParse(buf);
      text = parsed.text;
    } else if (lower.endsWith(".tex")) {
      latex = buf.toString("utf8");
      text = latexToText(latex);
    } else if (lower.endsWith(".txt") || lower.endsWith(".md") || file.type.startsWith("text/")) {
      text = buf.toString("utf8");
    } else {
      return NextResponse.json(
        { error: "Unsupported file. Upload a PDF, .tex, .txt, or .md (or paste the text)." },
        { status: 415 },
      );
    }
  } catch (e) {
    return NextResponse.json({ error: `Could not read the file: ${(e as Error).message}` }, { status: 422 });
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // persist the file alongside the extracted text
  const safe = `${Date.now()}-${name.replace(/[^\w.\-]+/g, "_")}`;
  let resumePath = "";
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    resumePath = join(UPLOAD_DIR, safe);
    await writeFile(resumePath, buf);
  } catch {
    resumePath = ""; // text extraction still succeeded; storing the file is best-effort
  }

  const repo = await getRepo();
  await ensureTenant(repo);
  const current = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  const next: Profile = {
    ...current,
    masterResume: text,
    // keep the raw .tex when a LaTeX résumé is imported (the tailor template)
    resumeLatex: latex || current.resumeLatex,
    // resume changed → drop the cached embedding so the next rank re-embeds
    profileEmbedding: null,
    prefs: {
      ...current.prefs,
      contact: { ...current.prefs.contact, resumePath: resumePath || current.prefs.contact.resumePath },
    },
  };
  await repo.saveProfile(next);

  return NextResponse.json({ text, fileName: name, resumePath, chars: text.length, isLatex: !!latex, latex });
}
