import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileStore, Repository } from "@jobflow/db";
import { defaultDataDir, ensurePrivateDir } from "@jobflow/db";
import { ApplicationStatus, COVER_LETTER_ANSWER_KEY, type Application, type Posting, type Profile } from "@jobflow/core";
import {
  buildFillPlan,
  mapContactToApplicant,
  renderDryRun,
  resolveApplyUrl,
  type ApplicantData,
  type FillPlan,
} from "@jobflow/autofill";
import { blankProfile } from "@jobflow/pipeline";
import { candidateName } from "@jobflow/llm";

/**
 * Assisted apply, the pure half (§7.1): everything the form-filler needs, resolved from
 * what the user stored — the posting, its application (saved answers, cover letter,
 * tailored PDF) and the profile's contact. Nothing is invented: a field with no stored
 * value is left for the human at review. This module never opens a browser and has no
 * notion of submitting (invariant #2); the CLI renders the plan, and only the local
 * runner types it into a page — then stops at the review screen.
 */

export interface ApplyResume {
  /** absolute path the filler would attach, or null when none is known */
  path: string | null;
  source: "tailored" | "profile" | "none";
  /** the file is on disk (a stale path is reported, never silently attached) */
  exists: boolean;
}

export interface ApplyPlan {
  posting: Posting;
  application: Application | null;
  /** where the form lives (Greenhouse postings resolve to the hosted form) */
  applyUrl: string | null;
  applicant: ApplicantData;
  /** null when the posting has no apply URL */
  plan: FillPlan | null;
  resume: ApplyResume;
  /** a saved cover letter is mapped to the form's cover-letter field */
  coverLetter: boolean;
  /** what the user should fix before filling: "email", "name", "resume", "resumeFormat", "applyUrl" */
  missing: string[];
  /** the dry-run text (what would be typed where) */
  dryRun: string;
}

export class ApplyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function onDisk(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The résumé to attach: this application's tailored PDF, else the profile's base résumé
 * (an explicit contact.resumePath, else the uploaded file in the file store).
 */
async function resolveResume(profile: Profile, app: Application | null, files: FileStore | null): Promise<ApplyResume> {
  if (app?.tailoredResumeUrl) return { path: app.tailoredResumeUrl, source: "tailored", exists: await onDisk(app.tailoredResumeUrl) };
  const explicit = profile.prefs.contact.resumePath?.trim();
  if (explicit) return { path: explicit, source: "profile", exists: await onDisk(explicit) };
  if (profile.resumeFile && files) {
    const p = await files.localPath(profile.resumeFile.key).catch(() => null);
    if (p) return { path: p, source: "profile", exists: true };
  }
  return { path: null, source: "none", exists: false };
}

/**
 * Build the fill plan for one posting — the same mapping the local agent's form_fill uses
 * (contact → ApplicantData, saved answers, cover letter to its own field, tailored PDF
 * first), with no page touched.
 */
export async function buildApplyPlan(
  repo: Repository,
  files: FileStore | null,
  tenantId: string,
  postingId: string,
): Promise<ApplyPlan> {
  const posting = await repo.getPosting(postingId);
  if (!posting) throw new ApplyError("That posting isn't in your corpus.", 404);
  // Greenhouse postings often link the employer's careers page, where the form is a
  // cross-origin iframe → open Greenhouse's hosted form instead (resolveApplyUrl)
  const company = posting.atsType === "greenhouse" ? await repo.getCompany(posting.companyId).catch(() => null) : null;
  const applyUrl = resolveApplyUrl(posting.atsType, posting.applyUrl, { slug: company?.atsSlug, jobId: posting.atsJobId });

  const profile = (await repo.getProfile(tenantId)) ?? blankProfile(tenantId);
  const application = await repo.getApplicationByPosting(tenantId, postingId);
  const { [COVER_LETTER_ANSWER_KEY]: coverLetter, ...answers } = application?.answers ?? {};
  const applicant = mapContactToApplicant(profile.prefs.contact, answers);
  if (coverLetter?.trim()) applicant.coverLetter = coverLetter;
  const resume = await resolveResume(profile, application, files);
  // only an existing file is attached — a dangling path would fail the upload mid-form
  applicant.resumePath = resume.exists ? resume.path ?? undefined : undefined;

  const missing: string[] = [];
  if (!applicant.email.trim()) missing.push("email");
  if (!`${applicant.firstName}${applicant.lastName}`.trim()) missing.push("name");
  if (!resume.exists) missing.push("resume");
  // application forms take PDF / Word; a .md/.tex/.txt base résumé would upload as-is
  else if (resume.path && !/\.(pdf|docx?)$/i.test(resume.path)) missing.push("resumeFormat");
  if (!applyUrl) missing.push("applyUrl");

  // unknown / aggregator sources get the conservative generic field map (fieldMapFor)
  const plan = applyUrl ? buildFillPlan(posting.atsType, applyUrl, applicant) : null;
  return {
    posting,
    application,
    applyUrl,
    applicant,
    plan,
    resume,
    coverLetter: !!coverLetter?.trim(),
    missing,
    dryRun: plan ? renderDryRun(plan) : "No apply URL on this posting — open the listing and apply there.",
  };
}

// ── the tracker (applications CRM) ──

export interface ApplicationPatch {
  status?: ApplicationStatus;
  nextAction?: string | null;
  nextActionAt?: Date | string | null;
  outcome?: string | null;
  /** shallow-merged into the saved answers */
  answers?: Record<string, string>;
  tailoredResumeUrl?: string | null;
  appliedVia?: string | null;
}

/**
 * Create-or-update this posting's application. Status only moves when asked; `applied`
 * stamps `submittedAt` once — and only ever because the user said they submitted.
 */
export async function trackApplication(
  repo: Repository,
  tenantId: string,
  postingId: string,
  patch: ApplicationPatch = {},
): Promise<Application> {
  const current = await repo.getApplicationByPosting(tenantId, postingId);
  const base: Application = current ?? {
    id: randomUUID(),
    tenantId,
    postingId,
    status: "saved",
    appliedVia: null,
    tailoredResumeUrl: null,
    resumeVariant: null,
    answers: {},
    submittedAt: null,
    nextAction: null,
    nextActionAt: null,
    outcome: null,
  };
  const status = patch.status ? ApplicationStatus.parse(patch.status) : base.status;
  const next: Application = {
    ...base,
    status,
    nextAction: patch.nextAction !== undefined ? patch.nextAction : base.nextAction,
    nextActionAt: patch.nextActionAt !== undefined ? (patch.nextActionAt == null ? null : new Date(patch.nextActionAt)) : base.nextActionAt,
    outcome: patch.outcome !== undefined ? patch.outcome : base.outcome,
    answers: patch.answers ? { ...base.answers, ...patch.answers } : base.answers,
    tailoredResumeUrl: patch.tailoredResumeUrl !== undefined ? patch.tailoredResumeUrl : base.tailoredResumeUrl,
    appliedVia: patch.appliedVia !== undefined ? patch.appliedVia : base.appliedVia,
    submittedAt: status === "applied" && !base.submittedAt ? new Date() : base.submittedAt,
  };
  return repo.upsertApplication(next);
}

/**
 * Save a compiled tailored PDF under the data dir and attach it to THIS application (not
 * the profile), so tailoring role B never clobbers role A's attachment. Same layout as the
 * web's PDF route; the file name is a plain one because the ATS shows it to the recruiter.
 */
export async function attachTailoredPdf(repo: Repository, tenantId: string, postingId: string, pdf: Uint8Array): Promise<string> {
  const profile = (await repo.getProfile(tenantId)) ?? blankProfile(tenantId);
  const who = candidateName(profile).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  const dir = join(defaultDataDir(), "files", "tenants", tenantId, "tailored", postingId);
  ensurePrivateDir(dir);
  const path = join(dir, `${who ? `${who}_` : ""}Resume.pdf`);
  await writeFile(path, pdf, { mode: 0o600 });
  const app = await repo.getApplicationByPosting(tenantId, postingId);
  await trackApplication(repo, tenantId, postingId, { tailoredResumeUrl: path, ...(app ? {} : { status: "drafting" }) });
  return path;
}
