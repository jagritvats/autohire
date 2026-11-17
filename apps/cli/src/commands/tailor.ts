import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { COVER_LETTER_ANSWER_KEY } from "@jobflow/core";
import { isOfflineProvider, markdownToLatex } from "@jobflow/llm";
import { KIND_QUESTION, attachTailoredPdf, compileLatex, generateTailored, tenantProvider, trackApplication, type DraftKind } from "@jobflow/service";
import type { Ctx } from "../context.js";
import { CliError, EXIT, SET_MODEL_HINT, needsSetup, usage } from "../errors.js";
import { resolvePosting } from "../refs.js";
import { requireProfile } from "./shared.js";

/**
 * Grounded generation for one posting (invariant #3): every bullet / answer / letter rests
 * on your base résumé, Evidence Bank or declared skills — rephrased, never extended. With
 * no model configured (the offline echo provider), documents fall back to deterministic
 * built-in templates and are labelled so; prose refuses (exit 4) rather than pass an echo
 * off as a draft.
 */

const KINDS: Record<string, DraftKind> = {
  resume: "resume",
  "resume-md": "resume_md",
  "resume-latex": "resume_latex",
  cover: "cover_letter",
  "why-here": "why_here",
  problem: "interesting_problem",
  about: "about_blurb",
  answer: "answer",
};
const DOCS: readonly DraftKind[] = ["resume", "resume_md", "resume_latex"];
const LABEL: Record<DraftKind, string> = {
  resume: "résumé bullets",
  resume_md: "Markdown résumé",
  resume_latex: "LaTeX résumé",
  cover_letter: "cover letter",
  why_here: '"why here" answer',
  interesting_problem: '"interesting problem" answer',
  about_blurb: '"about me"',
  answer: "answer",
};

interface TailorOpts {
  kind: string;
  question?: string;
  note?: string;
  out?: string;
  pdf?: boolean;
  force?: boolean;
  attach?: boolean;
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("tailor")
    .description("draft a tailored résumé, cover letter or answer for a posting — grounded in your own material")
    .argument("<ref>", "row number from the last listing, posting id, or id prefix")
    .option("-k, --kind <kind>", `${Object.keys(KINDS).join(" | ")}`, "resume")
    .option("-q, --question <text>", "the application question (for --kind answer)")
    .option("--note <text>", "cover letter: your own 'why this company' note to build on")
    .option("-o, --out <file>", "write the draft to a file (.pdf with --pdf)")
    .option("--pdf", "résumé: compile to PDF locally (needs tectonic or TeX) and attach it to this application")
    .option("--force", "regenerate even if a current draft is cached")
    .option("--no-attach", "don't save the letter/answer/PDF to this posting's application")
    .addHelpText(
      "after",
      `
Kinds:
  resume        3 bullet variants (startup / enterprise / product) + ATS keyword coverage
  resume-md     a full Markdown résumé          resume-latex  your LaTeX résumé, body rewritten
  cover         cover letter                    why-here      "Why do you want to work here?"
  problem       an interesting problem you solved              about  a short "about me"
  answer        any question: --question "…"
Without a model, résumés are built-in templates (labelled "builtin") and prose needs one:
  ${SET_MODEL_HINT}`,
    )
    .action(async (ref: string, o: TailorOpts) => {
      const kind = KINDS[o.kind.toLowerCase()];
      if (!kind) throw usage(`unknown kind "${o.kind}"`, `Kinds: ${Object.keys(KINDS).join(", ")}`);
      if (kind === "answer" && !o.question?.trim()) throw usage('--kind answer needs --question "…"');
      if (o.pdf && kind !== "resume_latex" && kind !== "resume_md") throw usage("--pdf works with --kind resume-latex or resume-md");
      await requireProfile(ctx);
      const repo = await ctx.repo();
      const llm = tenantProvider(await repo.getConfig(ctx.tenantId));
      if (!DOCS.includes(kind) && isOfflineProvider(llm)) {
        throw needsSetup(`Writing a ${LABEL[kind]} needs a generation model — the offline echo provider can't write prose.`, SET_MODEL_HINT);
      }
      const { posting, kept } = await resolvePosting(ctx, ref);
      if (kept) ctx.out.hint("(saved this search result to your corpus)");
      const spin = ctx.out.spinner(`Drafting the ${LABEL[kind]} for ${posting.title} · ${posting.companyName}${isOfflineProvider(llm) ? " (built-in)" : ` with ${llm.name}`}`);
      const d = await generateTailored(repo, ctx.tenantId, { postingId: posting.id, kind, question: o.question, note: o.note, force: o.force }).finally(() => spin.stop());

      // prose goes onto the application so `jobflow apply` types it into the form
      let attached: string | null = null;
      if (o.attach !== false && !DOCS.includes(kind) && d.source === "llm" && d.text.trim()) {
        const key = kind === "cover_letter" ? COVER_LETTER_ANSWER_KEY : kind === "answer" ? o.question!.trim() : KIND_QUESTION[kind as keyof typeof KIND_QUESTION];
        await trackApplication(repo, ctx.tenantId, posting.id, { answers: { [key]: d.text }, ...((await repo.getApplicationByPosting(ctx.tenantId, posting.id)) ? {} : { status: "drafting" }) });
        attached = key;
      }

      let pdfPath: string | null = null;
      if (o.pdf) {
        const latex = kind === "resume_latex" ? d.text : markdownToLatex(d.text);
        const s2 = ctx.out.spinner("Compiling PDF locally (tectonic's first run downloads its bundle — minutes)");
        const r = await compileLatex(latex).finally(() => s2.stop());
        if (!r.pdf) {
          if (r.noEngine) throw needsSetup(r.error ?? "No LaTeX engine found.", "Install tectonic (https://tectonic-typesetting.github.io), or use --out resume.tex and compile in Overleaf.");
          throw new CliError(r.error ?? "PDF compile failed.", EXIT.error, r.log ? r.log.split("\n").slice(-8).join("\n") : undefined);
        }
        if (o.attach !== false) pdfPath = await attachTailoredPdf(repo, ctx.tenantId, posting.id, r.pdf);
        if (o.out?.toLowerCase().endsWith(".pdf")) await writeFile(ctx.userPath(o.out), r.pdf);
      }

      const text = kind === "resume" ? variantsText(d.variants) : d.text;
      if (o.out && !(o.pdf && o.out.toLowerCase().endsWith(".pdf"))) await writeFile(ctx.userPath(o.out), text.endsWith("\n") ? text : text + "\n");

      ctx.out.emit({ posting: { id: posting.id, title: posting.title, company: posting.companyName }, ...d, attached, pdf: pdfPath, out: o.out ? ctx.userPath(o.out) : null }, () => {
        const out = ctx.out;
        const label =
          d.source === "builtin"
            ? out.yellow("builtin — a deterministic template from your own résumé, not tailored by a model")
            : out.green(`drafted by ${d.model}`);
        out.note(`${out.bold(LABEL[kind])} · ${posting.title} · ${posting.companyName} · ${label}${d.cached ? out.dim(" · cached") : ""}${d.edited ? out.dim(" · edited") : ""}`);
        for (const w of d.warnings) out.warn(w);
        if (!o.out) {
          out.line();
          out.line(text);
          out.line();
        } else out.ok(`wrote ${ctx.userPath(o.out)}`);
        if (kind === "resume" && d.variants) {
          out.hint(`ATS keyword coverage ${Math.round(d.variants.atsKeywordCoverage * 100)}%${d.variants.missingKeywords.length ? ` · not in your material: ${d.variants.missingKeywords.slice(0, 6).join(", ")} (only add them if they're true)` : ""}`);
        }
        if (d.source === "builtin") out.hint(`For a tailored draft, ${SET_MODEL_HINT}`);
        if (attached) out.hint(`saved to this posting's application — \`jobflow apply ${ref}\` will fill it in`);
        if (pdfPath) out.ok(`PDF attached to this application: ${pdfPath}`);
        out.hint("Review every line before you use it: it must all be true of you.");
      });
    });
}

function variantsText(v: { yc_startup: string[]; enterprise: string[]; product: string[] } | null): string {
  if (!v) return "";
  const block = (t: string, xs: string[]) => [t, ...xs.map((x) => `  • ${x}`)].join("\n");
  return [block("Startup (ownership, speed, shipped impact)", v.yc_startup), block("Enterprise (scale, reliability, rigor)", v.enterprise), block("Product (users, outcomes)", v.product)].join("\n\n");
}
