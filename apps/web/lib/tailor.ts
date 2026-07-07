import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import {
  answerGeneric,
  answerQuestion,
  createProvider,
  tailorResume,
  tailorResumeLatex,
  tailorResumeMarkdown,
  type ResumeVariants,
} from "@jobflow/llm";
import type { ConnectedContext, Evidence, Generation, GenerationKind, Posting, Profile } from "@jobflow/core";
import { getRepo, ensureTenant } from "./repo.js";

/**
 * Cache-aware, evidence-grounded generation (§4 "Customize"). Mirrors feed.ts — the
 * web app composes the repo + the @jobflow/llm generators (pipeline doesn't depend on
 * llm, so this lives here). Every draft is keyed by an `inputHash`: change your resume,
 * about, stack, or the posting, and the cached draft is treated as stale and regenerated.
 */

/** Canonical questions for the fixed kinds — kept stable so the cache slot is stable. */
export const KIND_QUESTION: Record<Exclude<GenerationKind, "answer" | "resume" | "resume_latex" | "resume_md">, string> = {
  why_here: "Why do you want to work here?",
  interesting_problem: "Describe a unique or interesting problem you've solved, and how.",
  about_blurb: "Write a short 'about me' for a job application.",
};

export interface GenerateInput {
  postingId?: string | null;
  kind: GenerationKind;
  /** free-form question (only for kind='answer'); otherwise the canonical one is used. */
  question?: string;
  force?: boolean;
}

export interface GenerationDTO {
  postingId: string | null;
  kind: GenerationKind;
  prompt: string;
  /** for kind='resume', this is the parsed variants; otherwise null. */
  variants: ResumeVariants | null;
  /** for non-resume kinds, the answer text; "" for resume. */
  text: string;
  model: string;
  cached: boolean;
  createdAt: string;
}

/** Resolve the slot prompt for a kind (free-form answers carry their own question). */
function slotPrompt(kind: GenerationKind, question?: string): string {
  if (kind === "answer") return (question ?? "").trim();
  if (kind === "resume" || kind === "resume_latex" || kind === "resume_md") return "";
  return KIND_QUESTION[kind];
}

/** Stable fingerprint of everything the draft depends on (§ cache invalidation). */
function inputHash(
  profile: Profile,
  evidence: Evidence[],
  contexts: ConnectedContext[],
  posting: Posting | null,
  kind: GenerationKind,
  prompt: string,
  model: string,
): string {
  const evidenceSig = evidence
    .map((e) => `${e.project}|${e.headline}|${e.metric ?? ""}`)
    .sort()
    .join("§");
  const contextSig = contexts
    .filter((c) => c.enabled)
    .map((c) => `${c.source}:${new Date(c.syncedAt as string | Date).getTime()}:${c.content.length}`)
    .sort()
    .join("§");
  const payload = JSON.stringify({
    resume: profile.masterResume,
    latex: profile.resumeLatex,
    about: profile.aboutText,
    stack: [...profile.prefs.stackProfile].sort(),
    yoe: profile.yoe,
    level: profile.levelBand,
    evidence: evidenceSig,
    contexts: contextSig,
    posting: posting ? { t: posting.title, s: [...posting.jdSkills].sort(), jd: posting.jdText.slice(0, 1500) } : null,
    kind,
    prompt,
    model,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function toDTO(g: Generation, cached: boolean): GenerationDTO {
  const isResume = g.kind === "resume";
  return {
    postingId: g.postingId,
    kind: g.kind,
    prompt: g.prompt,
    variants: isResume ? safeVariants(g.content) : null,
    text: isResume ? "" : g.content,
    model: g.model,
    cached,
    createdAt: new Date(g.createdAt as string | Date).toISOString(),
  };
}

function safeVariants(content: string): ResumeVariants | null {
  try {
    return JSON.parse(content) as ResumeVariants;
  } catch {
    return null;
  }
}

/** Generate (or return cached) a draft for the given slot. */
export async function generateTailored(input: GenerateInput): Promise<GenerationDTO> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const tenantId = DEFAULT_TENANT;
  const postingId = input.postingId ?? null;
  const prompt = slotPrompt(input.kind, input.question);

  const [profile, evidence, config, contexts] = await Promise.all([
    repo.getProfile(tenantId).then((p) => p ?? defaultProfile()),
    repo.listEvidence(tenantId),
    repo.getConfig(tenantId),
    repo.listContexts(tenantId),
  ]);
  const posting = postingId ? await repo.getPosting(postingId) : null;
  if (postingId && !posting) throw new Error("posting not found");

  // settings drive the provider; blank fields fall back to env / provider defaults.
  const llmChoice = config?.llmChoice && config.llmChoice !== "echo" ? config.llmChoice : undefined;
  const llm = createProvider({
    provider: llmChoice,
    apiKey: config?.llmApiKey || undefined,
    strongModel: config?.llmModel || undefined,
    baseUrl: config?.llmBaseUrl || undefined,
  });
  const hash = inputHash(profile, evidence, contexts, posting, input.kind, prompt, llm.name);

  // cache hit: the slot exists and its inputs haven't changed
  if (!input.force) {
    const existing = await repo.getGeneration(tenantId, postingId, input.kind, prompt);
    if (existing && existing.inputHash === hash) return toDTO(existing, true);
  }

  const content = await runGenerator(input.kind, prompt, llm, profile, evidence, posting, contexts);
  const saved = await repo.saveGeneration({
    id: randomUUID(),
    tenantId,
    postingId,
    kind: input.kind,
    prompt,
    content,
    model: llm.name,
    inputHash: hash,
    createdAt: new Date(),
  });
  return toDTO(saved, false);
}

async function runGenerator(
  kind: GenerationKind,
  prompt: string,
  llm: ReturnType<typeof createProvider>,
  profile: Profile,
  evidence: Evidence[],
  posting: Posting | null,
  contexts: ConnectedContext[],
): Promise<string> {
  if (kind === "resume") {
    if (!posting) throw new Error("resume tailoring needs a posting");
    const variants = await tailorResume(llm, profile, evidence, posting, contexts);
    return JSON.stringify(variants);
  }
  if (kind === "resume_latex") {
    if (!posting) throw new Error("LaTeX résumé tailoring needs a posting");
    return tailorResumeLatex(llm, profile, evidence, posting, contexts);
  }
  if (kind === "resume_md") {
    if (!posting) throw new Error("Markdown résumé tailoring needs a posting");
    return tailorResumeMarkdown(llm, profile, evidence, posting, contexts);
  }
  // posting-specific questions go through answerQuestion; generic ones through answerGeneric
  if (posting && kind !== "about_blurb") {
    return answerQuestion(llm, profile, evidence, posting, prompt, contexts);
  }
  return answerGeneric(llm, profile, evidence, prompt, contexts);
}

/** Cached drafts for a posting (or generic when postingId is null/omitted) — for the UI. */
export async function listTailored(postingId?: string | null): Promise<GenerationDTO[]> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const rows = await repo.listGenerations(DEFAULT_TENANT, postingId);
  return rows.map((g) => toDTO(g, true));
}

/** Force-refresh: drop cached drafts (all, or one posting's). */
export async function clearTailored(postingId?: string | null): Promise<number> {
  const repo = await getRepo();
  await ensureTenant(repo);
  return repo.clearGenerations(DEFAULT_TENANT, postingId === undefined ? undefined : { postingId });
}
