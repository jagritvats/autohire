import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HONEST_VOICE, candidateBlock, evidenceBlock, jdBlock } from "@jobflow/llm";
import { isOnboarded, loadProfile } from "@jobflow/pipeline";
import { findSearch, getFeed } from "@jobflow/service";
import { jobLines, summarize } from "./dto.js";
import { ToolError, findPosting, type TransientResults } from "./refs.js";
import type { JobflowMcpContext } from "./server.js";

/**
 * MCP prompts. `tailor_application` is how invariant #3 reaches an agent that writes with
 * ITS OWN model: the prompt carries JobFlow's HONEST_VOICE rules verbatim, the candidate's
 * own material (base résumé, declared skills, Evidence Bank) and the role's requirements,
 * so the client model rephrases / reorders / trims the candidate's material and never
 * extends it — the same contract JobFlow's own generators run under.
 */

export const TAILOR_KINDS = ["resume_md", "resume_latex", "resume", "cover_letter", "why_here", "interesting_problem", "about_blurb", "answer"] as const;
type TailorKind = (typeof TAILOR_KINDS)[number];

const TASK: Record<TailorKind, string> = {
  resume_md:
    "Write a one-page Markdown résumé for this role. Reorder sections and bullets so the most relevant material comes first; trim what doesn't help this role. Keep every employer, title, date and number exactly as given.",
  resume_latex:
    "Rewrite ONLY the body of the candidate's LaTeX résumé (between \\begin{document} and \\end{document}) for this role — reorder, rephrase and trim; keep the preamble byte-for-byte and keep it compiling. If there is no LaTeX source below, write Markdown instead and say so.",
  resume:
    "Write three variants of 3–5 résumé bullets each — Startup (ownership, speed, shipped impact), Enterprise (scale, reliability, rigor), Product (users, outcomes) — then list which of the role's keywords the material does NOT cover.",
  cover_letter:
    "Write a short cover letter (under 250 words): why this role, and the two or three most relevant things the candidate has actually done. No flattery of the company beyond what the candidate's own note or material says.",
  why_here: 'Answer "Why do you want to work here?" in 80–150 words, from what the candidate\'s material and the job description actually support.',
  interesting_problem: "Describe one interesting problem the candidate solved, and how — chosen from their material for relevance to this role. 120–200 words.",
  about_blurb: 'Write a short "about me" (60–100 words) for this application.',
  answer: "Answer the application question below in the candidate's voice, 60–200 words.",
};

const LABEL: Record<TailorKind, string> = {
  resume_md: "Markdown résumé",
  resume_latex: "LaTeX résumé",
  resume: "résumé bullet variants",
  cover_letter: "cover letter",
  why_here: '"why here" answer',
  interesting_problem: '"interesting problem" answer',
  about_blurb: '"about me"',
  answer: "application answer",
};

export function registerPrompts(server: McpServer, ctx: JobflowMcpContext, transient: TransientResults): void {
  server.registerPrompt(
    "tailor_application",
    {
      title: "Tailor an application (grounded)",
      description:
        "Write a résumé / cover letter / answer for one job with YOUR model, under JobFlow's grounding rules: the HONEST_VOICE rules, the candidate's own material (base résumé, skills, Evidence Bank) and the role's requirements. Rephrase, reorder and trim the candidate's material — never extend it.",
      argsSchema: {
        jobId: z.string().describe("posting id (or unique prefix) from list_jobs / search_jobs"),
        kind: z.string().optional().describe(`one of: ${TAILOR_KINDS.join(", ")} (default resume_md)`),
        question: z.string().optional().describe("for kind=answer: the application question"),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const kind = (args.kind?.trim().toLowerCase().replace(/-/g, "_") || "resume_md") as TailorKind;
      if (!TAILOR_KINDS.includes(kind)) throw new ToolError(`unknown kind "${args.kind}" — use one of: ${TAILOR_KINDS.join(", ")}`);
      if (kind === "answer" && !args.question?.trim()) throw new ToolError('kind "answer" needs the question argument.');
      return ctx.withRepo(async (repo) => {
        const profile = await loadProfile(repo, ctx.tenantId);
        if (!isOnboarded(profile)) throw new ToolError("The user's profile isn't set up — there is no material to ground anything in. They run `jobflow init` first.");
        const { posting } = await findPosting(repo, ctx.tenantId, transient, args.jobId);
        const evidence = await repo.listEvidence(ctx.tenantId);
        const match = (await repo.listMatchesForPostings(ctx.tenantId, [posting.id]).catch(() => []))[0] ?? null;
        const must = posting.requirements.filter((r) => r.strength === "must_have").map((r) => r.skill);
        const nice = posting.requirements.filter((r) => r.strength !== "must_have").map((r) => r.skill);
        const notes = [
          match?.stackNote ? `- stack fit: ${match.stackNote}` : null,
          match?.levelNote ? `- level: ${match.levelNote}` : null,
          ...(match?.redFlags ?? []).map((f) => `- watch: ${f}`),
        ].filter(Boolean);
        const latex = kind === "resume_latex" && profile.resumeLatex.trim() ? `\nTHE CANDIDATE'S LATEX RÉSUMÉ (rewrite only its body):\n${profile.resumeLatex.slice(0, 20_000)}\n` : "";

        const text = [
          `You are drafting a ${LABEL[kind]} for the candidate below, for the role below. Write it yourself, but follow JobFlow's grounding rules exactly — they are the same rules JobFlow's own generators run under.`,
          "",
          "RULES (apply to every line you write):",
          HONEST_VOICE,
          "- Your job is to rephrase, reorder and trim the candidate's own material — never to extend it. If the role asks for something the material doesn't show, do not claim it: list it under \"Gaps\" after the draft.",
          "- Use only the material below. Don't add anything you know or assume about the candidate or the company from elsewhere.",
          "",
          candidateBlock(profile) || "CANDIDATE MATERIAL: (none — say so instead of writing anything)",
          "",
          "EVIDENCE BANK (extra project detail — citeable as [E1], [E2], …):",
          evidenceBlock(evidence),
          latex,
          jdBlock(posting),
          must.length ? `MUST-HAVES: ${must.join(", ")}` : "",
          nice.length ? `NICE-TO-HAVES: ${nice.join(", ")}` : "",
          notes.length ? `JOBFLOW'S FIT NOTES (from its scorer — use them to decide emphasis and to name gaps honestly):\n${notes.join("\n")}` : "",
          "",
          `TASK: ${TASK[kind]}`,
          kind === "answer" ? `QUESTION: ${args.question!.trim()}` : "",
          "",
          "After the draft, add two short lists: (1) Gaps — requirements the material does not support (don't paper over them); (2) Sources — for each section or bullet, the material it rests on ([E#], \"base résumé\" or \"declared skills\").",
          "The candidate reviews every line before using it. JobFlow never submits applications; when they're ready, they run `jobflow apply " + posting.id + " --fill`, review the form and send it themselves.",
        ]
          .filter((l) => l !== "")
          .join("\n");
        return {
          description: `Grounded ${LABEL[kind]} for ${posting.title} · ${posting.companyName}`,
          messages: [{ role: "user", content: { type: "text", text } }],
        };
      });
    },
  );

  server.registerPrompt(
    "triage_jobs",
    {
      title: "Triage my top jobs",
      description:
        "Walk the user's top N jobs (optionally through a saved search or preset tag): explain each fit honestly from JobFlow's own flags, and recommend which to apply to first and why.",
      argsSchema: {
        count: z.string().optional().describe("how many jobs (default 10, max 30)"),
        savedSearch: z.string().optional().describe("view the feed through this saved search"),
        preset: z.string().optional().describe("only roles tagged with this preset (india, us, eu-uk, global-remote)"),
      },
    },
    async (args): Promise<GetPromptResult> => {
      const n = Math.max(1, Math.min(30, Number(args.count) || 10));
      return ctx.withRepo(async (repo) => {
        const presets = args.preset ? [args.preset.trim().toLowerCase()] : [];
        let view: unknown = null;
        if (args.savedSearch) {
          const s = await findSearch(repo, ctx.tenantId, args.savedSearch);
          if (!s) throw new ToolError(`No saved search "${args.savedSearch}".`);
          view = presets.length ? { ...s.query, presets } : s.id;
        } else if (presets.length) view = { presets };
        const data = await getFeed(repo, ctx.tenantId, { limit: Math.max(n * 3, 60), view: view as never, bootstrap: false });
        const scored = data.stats.mode === "ranked";
        const jobs = data.cards.filter((c) => !c.archived && !c.applied).slice(0, n).map((c) => summarize(c, scored));
        const listing = jobs.length ? jobs.map((j, i) => jobLines(j, i + 1)).join("\n\n") : "(no jobs — the corpus is empty or the view hid everything)";
        const hidden = data.stats.hiddenTotal ? `\nThe view hid ${data.stats.hiddenTotal} role(s): ${Object.entries(data.stats.hidden ?? {}).filter(([, k]) => k > 0).map(([k, v]) => `${k} ${v}`).join(", ")}.` : "";
        const text = [
          `Help me triage my top ${jobs.length} job(s) from JobFlow${args.savedSearch ? ` (saved search "${args.savedSearch}")` : ""}${presets.length ? ` (#${presets[0]})` : ""}.`,
          scored ? "Scores are 0–100 fit against my profile." : "These are NOT scored — my profile isn't set up yet, so don't guess at fit; say that it can't be judged yet.",
          "",
          listing,
          hidden,
          "",
          "For each job: explain the fit honestly in two or three sentences, citing JobFlow's own notes (fit / level / watch lines) — don't hide a red flag or an experience gap, and call estimated pay an estimate.",
          "Then recommend which ones to apply to first and why, and which to skip and why. Use get_job for a closer look before recommending (the description and must-haves), and stay within what the cards and descriptions say — don't invent facts about the companies.",
          "Finish with next steps: draft_document or the tailor_application prompt for the ones worth it, track_application to save them, and prepare_application to check what's missing. JobFlow never submits — I review and send every application myself.",
        ].join("\n");
        return { description: `Triage of ${jobs.length} job(s)`, messages: [{ role: "user", content: { type: "text", text } }] };
      });
    },
  );
}
