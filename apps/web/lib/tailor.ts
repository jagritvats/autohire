import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import {
  ProviderError,
  answerGeneric,
  answerQuestion,
  createProvider,
  isOfflineProvider,
  tailorResume,
  tailorResumeLatex,
  tailorResumeMarkdown,
  writeCoverLetter,
  type LlmProvider,
  type ResumeVariants,
} from "@jobflow/llm";
import type { ConnectedContext, Evidence, Generation, GenerationKind, Posting, Profile, TenantConfig } from "@jobflow/core";
import { getRepo, ensureTenant } from "./repo.js";

/**
 * Cache-aware, grounded generation (§4 "Customize"). Mirrors feed.ts — the web app
 * composes the repo + the @jobflow/llm generators (pipeline doesn't depend on llm, so
 * this lives here). Every draft is keyed by an `inputHash`: change your résumé, about,
 * skills, evidence, contact, the model, or the posting, and the draft reads as stale.
 */

/** Bump when the generators/prompts change, so drafts made by the old ones read as stale. */
const PROMPT_VERSION = 2;

/** kinds the tailoring UI drafts — "rerank" is the ranker's cached match write-up, not a draft */
export type DraftKind = Exclude<GenerationKind, "rerank">;

/** Drafts that are documents (not answers to a question). */
type DocKind = "resume" | "resume_latex" | "resume_md" | "cover_letter";
const DOC_KINDS: readonly DraftKind[] = ["resume", "resume_latex", "resume_md", "cover_letter"];

/** Canonical questions for the fixed kinds — kept stable so the cache slot is stable. */
export const KIND_QUESTION: Record<Exclude<DraftKind, "answer" | DocKind>, string> = {
  why_here: "Why do you want to work here?",
  interesting_problem: "Describe a unique or interesting problem you've solved, and how.",
  about_blurb: "Write a short 'about me' for a job application.",
};

export interface GenerateInput {
  postingId?: string | null;
  kind: DraftKind;
  /** free-form question (only for kind='answer'); otherwise the canonical one is used. */
  question?: string;
  /** cover letter only: the candidate's own "why this company" note. */
  note?: string;
  force?: boolean;
}

export interface GenerationDTO {
  postingId: string | null;
  kind: GenerationKind;
  prompt: string;
  /** for kind='resume', the parsed variants; otherwise null. */
  variants: ResumeVariants | null;
  /** the document / answer text; "" for kind='resume'. */
  text: string;
  /** cover letter: the note it was written from. */
  note: string;
  /** the provider that wrote it, or "builtin" (deterministic, untailored). */
  model: string;
  source: "llm" | "builtin";
  /** the user edited it after generation (regenerating replaces the edits). */
  edited: boolean;
  /** its inputs changed since it was made — regenerate to pick them up. */
  stale: boolean;
  /** non-fatal notes from this generation (only on a fresh draft). */
  warnings: string[];
  cached: boolean;
  createdAt: string;
}

/** Everything a draft depends on, loaded once per request. */
interface Inputs {
  profile: Profile;
  evidence: Evidence[];
  contexts: ConnectedContext[];
  config: TenantConfig | null;
  posting: Posting | null;
  llm: LlmProvider;
}

async function loadInputs(repo: Repository, postingId: string | null): Promise<Inputs> {
  const [profile, evidence, config, contexts, posting] = await Promise.all([
    repo.getProfile(DEFAULT_TENANT).then((p) => p ?? defaultProfile()),
    repo.listEvidence(DEFAULT_TENANT),
    repo.getConfig(DEFAULT_TENANT),
    repo.listContexts(DEFAULT_TENANT),
    postingId ? repo.getPosting(postingId) : Promise.resolve(null),
  ]);
  if (postingId && !posting) throw new ProviderError("That posting no longer exists.", postingId, 404);
  // settings drive the provider; blank fields fall back to env / provider defaults.
  const llmChoice = config?.llmChoice && config.llmChoice !== "echo" ? config.llmChoice : undefined;
  const llm = createProvider({
    provider: llmChoice,
    apiKey: config?.llmApiKey || undefined,
    strongModel: config?.llmModel || undefined,
    baseUrl: config?.llmBaseUrl || undefined,
  });
  return { profile, evidence, contexts, config, posting, llm };
}

/** Resolve the slot prompt for a kind (free-form answers carry their own question). */
function slotPrompt(kind: DraftKind, question?: string): string {
  if (kind === "answer") return (question ?? "").trim();
  if (DOC_KINDS.includes(kind)) return "";
  return KIND_QUESTION[kind as keyof typeof KIND_QUESTION];
}

/** Stable fingerprint of everything the draft depends on (§ cache invalidation). */
function inputHash({ profile, evidence, contexts, config, posting, llm }: Inputs, kind: GenerationKind, prompt: string, note: string): string {
  const { resumePath: _file, ...contact } = profile.prefs.contact;
  const payload = JSON.stringify({
    v: PROMPT_VERSION,
    resume: profile.masterResume,
    latex: profile.resumeLatex,
    about: profile.aboutText,
    stack: [...profile.prefs.stackProfile].sort(),
    yoe: profile.yoe,
    level: profile.levelBand,
    contact,
    evidence: evidence.map((e) => [e.project, e.headline, e.detail, e.metric ?? "", [...e.tags].sort().join(",")].join("|")).sort(),
    contexts: contexts
      .filter((c) => c.enabled)
      .map((c) => `${c.source}:${new Date(c.syncedAt as string | Date).getTime()}:${c.content.length}`)
      .sort(),
    posting: posting ? { t: posting.title, s: [...posting.jdSkills].sort(), jd: posting.jdText } : null,
    kind,
    prompt,
    note,
    model: `${llm.name}:${config?.llmModel || process.env.LLM_MODEL_STRONG || ""}`,
  });
  return createHash("sha256").update(payload).digest("hex");
}

const EDITED = "+edited";

function parseLetter(content: string): { text: string; note: string } {
  try {
    const v = JSON.parse(content) as { text?: string; note?: string };
    return { text: v.text ?? "", note: v.note ?? "" };
  } catch {
    return { text: content, note: "" };
  }
}

function safeVariants(content: string): ResumeVariants | null {
  try {
    return JSON.parse(content) as ResumeVariants;
  } catch {
    return null;
  }
}

function toDTO(g: Generation, extra: { cached: boolean; stale: boolean; warnings?: string[] }): GenerationDTO {
  const edited = g.model.endsWith(EDITED);
  const model = edited ? g.model.slice(0, -EDITED.length) : g.model;
  const letter = g.kind === "cover_letter" ? parseLetter(g.content) : null;
  return {
    postingId: g.postingId,
    kind: g.kind,
    prompt: g.prompt,
    variants: g.kind === "resume" ? safeVariants(g.content) : null,
    text: g.kind === "resume" ? "" : letter ? letter.text : g.content,
    note: letter?.note ?? "",
    model,
    // "echo" rows predate the builtin label — they were deterministic too
    source: model === "builtin" || model === "echo" ? "builtin" : "llm",
    edited,
    stale: extra.stale,
    warnings: extra.warnings ?? [],
    cached: extra.cached,
    createdAt: new Date(g.createdAt as string | Date).toISOString(),
  };
}

/** Echo text saved by the old answer path is the prompt echoed back — never a draft. */
function isEchoJunk(g: Generation): boolean {
  return g.content.startsWith("[echo:");
}

/** Generate (or return cached) a draft for the given slot. */
export async function generateTailored(input: GenerateInput): Promise<GenerationDTO> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const postingId = input.postingId ?? null;
  const inp = await loadInputs(repo, postingId);
  const prompt = slotPrompt(input.kind, input.question);
  const note = input.kind === "cover_letter" ? (input.note ?? "").trim() : "";
  const hash = inputHash(inp, input.kind, prompt, note);

  // cache hit: the slot exists and its inputs haven't changed
  if (!input.force) {
    const existing = await repo.getGeneration(DEFAULT_TENANT, postingId, input.kind, prompt);
    if (existing && existing.inputHash === hash && !isEchoJunk(existing)) return toDTO(existing, { cached: true, stale: false });
  }

  const out = await runGenerator(input.kind, prompt, note, inp);
  const saved = await repo.saveGeneration({
    id: randomUUID(),
    tenantId: DEFAULT_TENANT,
    postingId,
    kind: input.kind,
    prompt,
    content: out.content,
    model: out.source === "builtin" ? "builtin" : inp.llm.name,
    inputHash: hash,
    createdAt: new Date(),
  });
  return toDTO(saved, { cached: false, stale: false, warnings: out.warnings });
}

const NEEDS_MODEL =
  "This needs a generation model — the offline echo stub can't write prose. Set one in Settings › Generation model.";

async function runGenerator(
  kind: DraftKind,
  prompt: string,
  note: string,
  { llm, profile, evidence, posting, contexts }: Inputs,
): Promise<{ content: string; source: "llm" | "builtin"; warnings: string[] }> {
  const offline = isOfflineProvider(llm);
  if (DOC_KINDS.includes(kind) && !posting) throw new ProviderError("Tailoring needs a posting.", kind, 400);
  if (kind === "resume") {
    const variants = await tailorResume(llm, profile, evidence, posting!, contexts);
    return { content: JSON.stringify(variants), source: offline ? "builtin" : "llm", warnings: [] };
  }
  if (kind === "resume_latex" || kind === "resume_md") {
    const gen = kind === "resume_latex" ? tailorResumeLatex : tailorResumeMarkdown;
    const doc = await gen(llm, profile, evidence, posting!, contexts);
    return { content: doc.text, source: doc.source, warnings: doc.warnings };
  }
  // prose: the echo stub would only parrot the prompt back — refuse rather than save
  // something that could end up typed into a real application form
  if (offline) throw new ProviderError(NEEDS_MODEL, "", 400);
  if (kind === "cover_letter") {
    const text = await writeCoverLetter(llm, profile, evidence, posting!, contexts, note);
    return { content: JSON.stringify({ text, note }), source: "llm", warnings: [] };
  }
  // posting-specific questions go through answerQuestion; generic ones through answerGeneric
  const text =
    posting && kind !== "about_blurb"
      ? await answerQuestion(llm, profile, evidence, posting, prompt, contexts)
      : await answerGeneric(llm, profile, evidence, prompt, contexts);
  return { content: text, source: "llm", warnings: [] };
}

/**
 * Save the user's edit of a draft in place. The input hash is kept, so the draft still
 * reads as current until its inputs change; it's marked edited so the UI can warn
 * before a regenerate replaces it.
 */
export async function saveEditedDraft(input: { postingId: string | null; kind: DraftKind; question?: string; text: string }): Promise<GenerationDTO> {
  if (input.kind === "resume") throw new ProviderError("Bullet variants aren't edited as text.", "", 400);
  const repo = await getRepo();
  await ensureTenant(repo);
  const existing = await repo.getGeneration(DEFAULT_TENANT, input.postingId, input.kind, slotPrompt(input.kind, input.question));
  if (!existing) throw new ProviderError("There's no draft to save yet — generate one first.", "", 404);
  const content = input.kind === "cover_letter" ? JSON.stringify({ text: input.text, note: parseLetter(existing.content).note }) : input.text;
  const model = existing.model.endsWith(EDITED) ? existing.model : existing.model + EDITED;
  const saved = await repo.saveGeneration({ ...existing, content, model });
  return toDTO(saved, { cached: true, stale: false });
}

/** Cached drafts for a posting (or generic when postingId is null/omitted) — for the UI.
 *  For one posting, each draft also says whether its inputs have changed since. */
export async function listTailored(postingId?: string | null): Promise<GenerationDTO[]> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const rows = (await repo.listGenerations(DEFAULT_TENANT, postingId)).filter((g) => g.kind !== "rerank" && !isEchoJunk(g));
  const inp = typeof postingId === "string" ? await loadInputs(repo, postingId).catch(() => null) : null;
  return rows.map((g) =>
    toDTO(g, {
      cached: true,
      stale: inp ? inputHash(inp, g.kind, g.prompt, g.kind === "cover_letter" ? parseLetter(g.content).note : "") !== g.inputHash : false,
    }),
  );
}

/** Force-refresh: drop cached drafts (all, or one posting's). */
export async function clearTailored(postingId?: string | null): Promise<number> {
  const repo = await getRepo();
  await ensureTenant(repo);
  return repo.clearGenerations(DEFAULT_TENANT, postingId === undefined ? undefined : { postingId });
}
