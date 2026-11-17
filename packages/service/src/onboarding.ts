import type { Repository, FileStore } from "@jobflow/db";
import type { LevelBand, ProfilePrefs, ResumeDraft, StoredFile, Contact } from "@jobflow/core";
import { applyResumeImport, completeOnboarding, profileReadiness, loadProfile } from "@jobflow/pipeline";
import { importResumeFile, importResumeText, ResumeIoError } from "@jobflow/resume-io";
import { extractResumeAssisted, isOfflineProvider } from "@jobflow/llm";
import { tenantProvider } from "./tailor.js";
import { ensureTenant } from "./tenant.js";

/**
 * Résumé import + onboarding, shared by the web wizard and `jobflow init`. Import never
 * writes the profile: it returns a DRAFT the user reviews (the review step is the gate —
 * invariant #3). Only `finishOnboarding` writes, with what the user confirmed.
 */

export interface ImportInput {
  /** an uploaded file … */
  file?: { filename: string; mime?: string; bytes: Uint8Array };
  /** … or pasted text */
  text?: string;
  /** also run the (grounded) LLM-assisted extraction with the tenant's model */
  assist?: boolean;
}

export interface ImportResult {
  draft: ResumeDraft;
  file: StoredFile | null;
  /** the assisted pass ran with a real model (false with the offline echo stub) */
  assisted: boolean;
}

export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function importResume(
  repo: Repository,
  files: FileStore | null,
  tenantId: string,
  input: ImportInput,
): Promise<ImportResult> {
  await ensureTenant(repo, tenantId);
  let draft: ResumeDraft;
  try {
    if (input.file) draft = await importResumeFile(input.file);
    else if (input.text?.trim()) draft = importResumeText(input.text);
    else throw new ImportError("Upload a résumé file or paste its text.", 400);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e instanceof ResumeIoError) {
      const status = e.code === "too_large" ? 413 : e.code === "unsupported" ? 415 : 422;
      throw new ImportError(e.message, status);
    }
    throw new ImportError(`Could not read the résumé: ${(e as Error).message}`, 422);
  }

  let assisted = false;
  if (input.assist) {
    const llm = tenantProvider(await repo.getConfig(tenantId));
    if (!isOfflineProvider(llm)) {
      draft = await extractResumeAssisted(llm, draft.text, draft);
      assisted = draft.provenance === "llm_assisted";
    } else {
      draft = { ...draft, warnings: [...draft.warnings, "Assisted extraction needs a generation model — set one in Settings."] };
    }
  }

  const file = input.file && files ? await files.put(tenantId, "resume", input.file.filename, input.file.bytes, input.file.mime) : null;
  return { draft, file, assisted };
}

export interface OnboardingInput {
  /** the reviewed draft from `importResume` (omit to onboard without a résumé file) */
  draft?: ResumeDraft | null;
  file?: StoredFile | null;
  mode?: "merge" | "replace";
  /** indexes of draft evidence to keep (default: the ones marked selected) */
  acceptEvidence?: number[];
  contact?: Partial<Contact>;
  prefs?: Partial<ProfilePrefs>;
  yoe?: number;
  levelBand?: LevelBand;
  stackProfile?: string[];
  /** built-in discovery preset (india / global-remote / us / eu-uk) */
  discoveryPreset?: string;
}

/** Write what the user confirmed: résumé → profile + Evidence Bank, preferences, preset. */
export async function finishOnboarding(
  repo: Repository,
  files: FileStore | null,
  tenantId: string,
  input: OnboardingInput,
): Promise<{ evidenceAdded: number; readiness: ReturnType<typeof profileReadiness> }> {
  await ensureTenant(repo, tenantId);
  let evidenceAdded = 0;
  if (input.draft) {
    const r = await applyResumeImport(repo, tenantId, input.draft, {
      mode: input.mode ?? "replace",
      file: input.file ?? undefined,
      acceptEvidence: input.acceptEvidence,
    });
    evidenceAdded = r.evidenceAdded;
    // the agent attaches the real file: point contact.resumePath at the stored copy
    if (input.file && files) {
      const path = await files.localPath(input.file.key);
      if (path) input = { ...input, contact: { ...(input.contact ?? {}), resumePath: path } };
    }
  }
  const profile = await completeOnboarding(repo, tenantId, {
    contact: input.contact,
    prefs: input.prefs,
    yoe: input.yoe,
    levelBand: input.levelBand,
    stackProfile: input.stackProfile,
  });
  if (input.discoveryPreset) {
    const config = await repo.getConfig(tenantId);
    if (config) await repo.saveConfig({ ...config, discoveryPreset: input.discoveryPreset });
  }
  const evidence = await repo.listEvidence(tenantId);
  return { evidenceAdded, readiness: profileReadiness(profile, evidence.length) };
}

/** Where the tenant is in onboarding (drives the redirect + the readiness banner). */
export async function onboardingStatus(repo: Repository, tenantId: string) {
  await ensureTenant(repo, tenantId);
  const profile = await loadProfile(repo, tenantId);
  const evidence = await repo.listEvidence(tenantId);
  return {
    onboarded: profile.onboardedAt != null,
    readiness: profileReadiness(profile, evidence.length),
    profile,
    evidenceCount: evidence.length,
  };
}
