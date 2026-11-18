import type { FileStore, Repository } from "@jobflow/db";
import type { Application } from "@jobflow/core";
import { isOnboarded } from "@jobflow/pipeline";
import { buildApplyPlan, type ApplyPlan } from "./apply.js";
import { toCards, type FeedCard } from "./feed.js";
import { listTailored } from "./tailor.js";
import { ensureTenant } from "./tenant.js";

/**
 * One job, everything a person needs to decide and act on it — the hub the web Job page and
 * `jobflow show` render: the card (same DTO as the feed), the full description, the
 * requirements, the fit narrative when there is one, the tracker row, the drafts, and the
 * apply checklist (what's missing before a form can be pre-filled). Read-only.
 */

export type ApplyGap = "email" | "name" | "resume" | "resumeFormat" | "applyUrl";

export interface JobApplyReadiness {
  applyUrl: string | null;
  /** what to fix before pre-filling, in the order to fix it */
  missing: ApplyGap[];
  resume: { source: "tailored" | "profile" | "none"; fileName: string | null; exists: boolean };
  coverLetter: boolean;
  /** form fields the filler would type (by name), and the ones left for you at review */
  willFill: string[];
  leftForYou: string[];
  /** saved answers to free-text questions */
  answers: number;
}

export interface JobDetail {
  card: FeedCard;
  /** false before onboarding — the card's score is not shown and no fit notes exist */
  scored: boolean;
  description: string;
  requirements: { must: string[]; nice: string[] };
  postedAt: string | null;
  firstSeen: string;
  fit: { whyFit: string | null; gap: string | null } | null;
  application: Pick<Application, "id" | "status" | "nextAction" | "nextActionAt" | "submittedAt"> | null;
  drafts: Array<{ kind: string; source: "llm" | "builtin"; model: string; stale: boolean; createdAt: string }>;
  apply: JobApplyReadiness;
}

export class JobNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("That job isn't in your corpus (it may have been removed when its board stopped listing it).");
  }
}

const iso = (d: unknown): string | null => (d == null ? null : new Date(d as string | Date).toISOString());

export function applyReadiness(ap: ApplyPlan): JobApplyReadiness {
  const fileName = ap.resume.path ? ap.resume.path.split(/[/\\]/).pop() ?? null : null;
  return {
    applyUrl: ap.applyUrl,
    missing: ap.missing as ApplyGap[],
    resume: { source: ap.resume.source, fileName, exists: ap.resume.exists },
    coverLetter: ap.coverLetter,
    willFill: ap.plan ? ap.plan.fields.map((f) => f.field) : [],
    leftForYou: ap.plan ? ap.plan.unfilled : [],
    answers: ap.plan ? ap.plan.questionFields.length : 0,
  };
}

export async function getJob(repo: Repository, files: FileStore | null, tenantId: string, postingId: string): Promise<JobDetail> {
  await ensureTenant(repo, tenantId);
  const posting = await repo.getPosting(postingId).catch(() => null);
  if (!posting) throw new JobNotFoundError();
  const profile = await repo.getProfile(tenantId);
  const scored = isOnboarded(profile);
  const match = scored ? ((await repo.listMatchesForPostings(tenantId, [posting.id]))[0] ?? null) : null;
  const [card] = await toCards(repo, tenantId, [{ posting, match }]);
  const [ap, drafts] = await Promise.all([
    buildApplyPlan(repo, files, tenantId, posting.id),
    listTailored(repo, tenantId, posting.id).catch(() => []),
  ]);
  const app = ap.application;
  return {
    card: card!,
    scored: scored && !!match,
    description: posting.jdText,
    requirements: {
      must: posting.requirements.filter((r) => r.strength === "must_have").map((r) => r.skill),
      nice: posting.requirements.filter((r) => r.strength !== "must_have").map((r) => r.skill),
    },
    postedAt: iso(posting.postedAt),
    firstSeen: iso(posting.firstSeen)!,
    fit: match && (match.whyFit || match.gap) ? { whyFit: match.whyFit, gap: match.gap } : null,
    application: app
      ? { id: app.id, status: app.status, nextAction: app.nextAction, nextActionAt: app.nextActionAt, submittedAt: app.submittedAt }
      : null,
    drafts: drafts.map((d) => ({ kind: d.kind, source: d.source, model: d.model, stale: d.stale, createdAt: d.createdAt })),
    apply: applyReadiness(ap),
  };
}
