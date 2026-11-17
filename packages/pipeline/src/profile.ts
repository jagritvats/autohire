import { randomUUID } from "node:crypto";
import type { Contact, Evidence, LevelBand, Profile, ProfilePrefs, ResumeDraft, StoredFile } from "@jobflow/core";
import { normalizeForMatch } from "@jobflow/core";
import type { Repository } from "@jobflow/db";
import { blankProfile } from "./seed.js";

/**
 * Profile lifecycle for onboarding (§ onboarding): load-or-blank, readiness, applying a
 * reviewed résumé import, and finishing onboarding. Shared by web, CLI and worker so all
 * three apply an import the same way. Only what the user confirmed in the draft is
 * written — nothing is inferred here (invariant #3), and preferences the user set are
 * never overwritten by a résumé.
 */

/** The tenant's profile, or a blank one (not saved) for a first run. */
export async function loadProfile(repo: Repository, tenantId: string): Promise<Profile> {
  return (await repo.getProfile(tenantId)) ?? blankProfile(tenantId);
}

export type ReadinessGap = "resume" | "skills" | "prefs";

/**
 * What a profile still needs before matching/generation are meaningful: grounding
 * material (résumé text or Evidence Bank entries), a stack, and where the candidate wants
 * to work (home country or markets).
 */
export function profileReadiness(profile: Profile, evidenceCount: number): { ready: boolean; missing: ReadinessGap[] } {
  const missing: ReadinessGap[] = [];
  if (!profile.masterResume.trim() && !profile.resumeLatex.trim() && evidenceCount === 0) missing.push("resume");
  if (profile.prefs.stackProfile.length === 0) missing.push("skills");
  if (!profile.prefs.homeCountry.trim() && profile.prefs.markets.length === 0) missing.push("prefs");
  return { ready: missing.length === 0, missing };
}

export interface ApplyResumeImportOptions {
  /** "replace": the draft becomes the base résumé; "merge": fill gaps, union skills. */
  mode: "merge" | "replace";
  /** the uploaded file, already stored outside the repo tree */
  file?: StoredFile;
  /** indexes into `draft.evidence` to save; default = the ones marked `selected` */
  acceptEvidence?: number[];
}

const evidenceKey = (e: { project: string; headline: string }) => `${normalizeForMatch(e.project)}|${normalizeForMatch(e.headline)}`;

/**
 * Write a reviewed résumé draft into the profile + Evidence Bank.
 *  - replace: masterResume/resumeLatex := the draft's; stack := the draft's skills (when it
 *    found any); YoE/level := the draft's (when it had a basis).
 *  - merge: résumé text only fills an empty profile; stack is the union; YoE/level only
 *    when the profile has none yet.
 *  - both: contact fields fill only empty ones; evidence is deduped on normalized
 *    (project, headline) against the bank and within the batch; other prefs untouched;
 *    the profile embedding is reset so the next rank re-embeds.
 */
export async function applyResumeImport(
  repo: Repository,
  tenantId: string,
  draft: ResumeDraft,
  opts: ApplyResumeImportOptions,
): Promise<{ profile: Profile; evidenceAdded: number }> {
  const current = await loadProfile(repo, tenantId);
  const replace = opts.mode === "replace";
  const hasExperience = current.yoe > 0;

  const contact: Contact = { ...current.prefs.contact };
  for (const [k, v] of Object.entries(draft.contact) as Array<[keyof Contact, string | undefined]>) {
    if (k === "resumePath") continue;
    if (v && v.trim() && !contact[k].trim()) contact[k] = v.trim();
  }

  const draftSkills = draft.skills.canonical;
  const stackProfile = replace && draftSkills.length ? [...draftSkills] : [...new Set([...current.prefs.stackProfile, ...draftSkills])];

  let yoe = current.yoe;
  let levelBand: LevelBand = current.levelBand;
  if (replace || !hasExperience) {
    if (draft.yoe.confidence > 0) yoe = draft.yoe.value;
    if (draft.levelBand.confidence > 0) levelBand = draft.levelBand.value;
  }

  const masterResume = replace || !current.masterResume.trim() ? draft.text : current.masterResume;
  const resumeLatex = replace ? draft.latex : current.resumeLatex.trim() ? current.resumeLatex : draft.latex;

  const profile: Profile = {
    ...current,
    tenantId,
    masterResume,
    resumeLatex,
    yoe,
    levelBand,
    profileEmbedding: null,
    resumeFile: opts.file ?? current.resumeFile,
    prefs: { ...current.prefs, contact, stackProfile },
  };
  await repo.saveProfile(profile);

  const indexes = opts.acceptEvidence ?? draft.evidence.flatMap((e, i) => (e.selected ? [i] : []));
  const seen = new Set((await repo.listEvidence(tenantId)).map(evidenceKey));
  let evidenceAdded = 0;
  for (const i of indexes) {
    const d = draft.evidence[i];
    if (!d || !d.headline.trim()) continue;
    const key = evidenceKey(d);
    if (seen.has(key)) continue;
    seen.add(key);
    const e: Evidence = {
      id: randomUUID(),
      tenantId,
      project: d.project,
      headline: d.headline,
      detail: d.detail,
      metric: d.metric,
      tags: d.tags,
      embedding: null,
      origin: d.origin,
    };
    await repo.saveEvidence(e);
    evidenceAdded++;
  }
  return { profile, evidenceAdded };
}

export interface OnboardingPatch {
  contact?: Partial<Contact>;
  prefs?: Partial<ProfilePrefs>;
  yoe?: number;
  levelBand?: LevelBand;
  stackProfile?: string[];
}

/**
 * Finish onboarding with what the user confirmed on the last step (their own edits win
 * here — this is the review gate), and stamp `onboardedAt`.
 */
export async function completeOnboarding(
  repo: Repository,
  tenantId: string,
  patch: OnboardingPatch = {},
  opts: { now?: Date } = {},
): Promise<Profile> {
  const current = await loadProfile(repo, tenantId);
  const prefs: ProfilePrefs = {
    ...current.prefs,
    ...(patch.prefs ?? {}),
    contact: { ...current.prefs.contact, ...(patch.prefs?.contact ?? {}), ...stripUndefined(patch.contact ?? {}) },
  };
  if (patch.stackProfile) prefs.stackProfile = [...new Set(patch.stackProfile)];
  const profile: Profile = {
    ...current,
    tenantId,
    yoe: patch.yoe ?? current.yoe,
    levelBand: patch.levelBand ?? current.levelBand,
    prefs,
    onboardedAt: (opts.now ?? new Date()).toISOString(),
  };
  return repo.saveProfile(profile);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
