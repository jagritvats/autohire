import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Compile LaTeX → PDF on THIS machine (§ Customize). Detects a local engine
 * (tectonic → xelatex → pdflatex), runs it with **shell-escape disabled** in a throwaway
 * temp dir, and returns the PDF bytes. No external service touches your résumé. If no
 * engine is installed we surface `noEngine` so the UI offers the .tex (Overleaf) instead.
 */

export interface CompileResult {
  pdf?: Buffer;
  engine?: string;
  error?: string;
  log?: string;
  noEngine?: boolean;
}

type Engine = "tectonic" | "xelatex" | "pdflatex";
let cachedEngine: Engine | null | undefined; // undefined = not probed, null = none found

async function detectEngine(): Promise<Engine | null> {
  if (cachedEngine !== undefined) return cachedEngine;
  for (const e of ["tectonic", "xelatex", "pdflatex"] as Engine[]) {
    try {
      await exec(e, ["--version"], { timeout: 8000 });
      cachedEngine = e;
      return e;
    } catch {
      /* not installed — try the next */
    }
  }
  cachedEngine = null;
  return null;
}

export async function compileLatex(tex: string): Promise<CompileResult> {
  const engine = await detectEngine();
  if (!engine) {
    return {
      noEngine: true,
      error: "No LaTeX engine found. Install tectonic (recommended) or MiKTeX/TeX Live, or download the .tex and compile in Overleaf.",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "jobflow-tex-"));
  const texPath = join(dir, "resume.tex");
  const pdfPath = join(dir, "resume.pdf");
  const logPath = join(dir, "resume.log");
  try {
    await writeFile(texPath, tex, "utf8");
    // tectonic's first run downloads its package bundle — minutes, not seconds
    const opts = { cwd: dir, timeout: engine === "tectonic" ? 300_000 : 60_000, windowsHide: true } as const;
    if (engine === "tectonic") {
      await exec("tectonic", ["--outdir", dir, "--chatter", "minimal", "--keep-logs", texPath], opts).catch(() => {});
    } else {
      // run twice so any refs/section spacing settle; never enable shell-escape
      const args = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", dir, texPath];
      await exec(engine, args, opts).catch(() => {});
      await exec(engine, args, opts).catch(() => {});
    }

    const pdf = await readFile(pdfPath).catch(() => null);
    if (pdf && pdf.length > 0) return { pdf, engine };
    const log = (await readFile(logPath, "utf8").catch(() => "")).slice(-4000);
    return { engine, error: `${engine} did not produce a PDF.`, log };
  } catch (e) {
    const log = (await readFile(logPath, "utf8").catch(() => "")).slice(-4000);
    return { engine, error: (e as Error).message, log };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether a local engine is available (for UI hints). */
export async function latexEngineAvailable(): Promise<string | null> {
  return detectEngine();
}
