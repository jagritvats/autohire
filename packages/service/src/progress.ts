import type { Repository } from "@jobflow/db";
import { isOfflineProvider } from "@jobflow/llm";
import { isOnboarded, profileReadiness, blankProfile, type ReadinessGap } from "@jobflow/pipeline";
import { corpusSyncing } from "./feed.js";
import { tenantProvider } from "./tailor.js";
import { ensureTenant } from "./tenant.js";

/**
 * Where a person is in the first-run loop — set up who I am → fill the corpus → keep a
 * search → track an application — and the ONE next step. Drives the web "Get started"
 * checklist and the CLI's `jobflow` / `jobflow status` screen, so both say the same thing.
 * Read-only; never polls.
 */

export type SetupStepId = "profile" | "sync" | "search" | "track";

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
  /** short imperative label: "Add your résumé" */
  title: string;
  /** one sentence: why / what happens */
  detail: string;
  /** where to do it in the web app */
  href: string;
  /** the CLI command that does it */
  cli: string;
}

export interface SetupProgress {
  steps: SetupStep[];
  done: number;
  total: number;
  complete: boolean;
  /** the first step not done, else null */
  next: SetupStep | null;
  profile: { onboarded: boolean; name: string; missing: ReadinessGap[]; evidence: number; skills: number };
  corpus: { postings: number; matches: number; lastSyncAt: string | null; syncing: boolean };
  searches: number;
  applications: { total: number; applied: number; dueFollowUps: number };
  /** the generation model — optional; "echo" is the offline stub (no prose) */
  model: { configured: boolean; provider: string };
}

export async function setupProgress(repo: Repository, tenantId: string, now = Date.now()): Promise<SetupProgress> {
  await ensureTenant(repo, tenantId);
  const [profileRow, evidence, postings, companies, searches, apps, config] = await Promise.all([
    repo.getProfile(tenantId),
    repo.listEvidence(tenantId),
    repo.listActivePostings(),
    repo.listCompanies(),
    repo.listSavedSearches(tenantId),
    repo.listApplications(tenantId),
    repo.getConfig(tenantId),
  ]);
  const profile = profileRow ?? blankProfile(tenantId);
  const onboarded = isOnboarded(profile);
  const matches = onboarded ? (await repo.listMatches(tenantId, 1)).length : 0;
  const polled = companies.map((c) => (c.lastPolled ? new Date(c.lastPolled as string | Date).getTime() : 0));
  const lastPolled = Math.max(0, ...polled);
  const applied = apps.filter((a) => a.submittedAt != null || ["applied", "screening", "interviewing", "offer"].includes(a.status)).length;
  const dueFollowUps = apps.filter(
    (a) => a.nextActionAt && new Date(a.nextActionAt as string | Date).getTime() <= now && !["rejected", "withdrawn", "ghosted"].includes(a.status),
  ).length;
  const llm = tenantProvider(config);
  const name = [profile.prefs.contact.firstName, profile.prefs.contact.lastName].filter(Boolean).join(" ");

  const steps: SetupStep[] = [
    {
      id: "profile",
      done: onboarded,
      title: "Add your résumé",
      detail: "JobFlow reads it, you check what it found, then every job is scored against you.",
      href: "/onboarding",
      cli: "jobflow init",
    },
    {
      id: "sync",
      done: postings.length > 0,
      title: "Fetch jobs",
      detail: "Pull roles from the boards in your discovery presets. The first sync takes a minute or two.",
      href: "/sources",
      cli: "jobflow sync",
    },
    {
      id: "search",
      done: searches.length > 0,
      title: "Save a search",
      detail: "A saved search runs on every sync and becomes a tab on your Jobs page.",
      href: "/search",
      cli: 'jobflow search "backend engineer" --remote --save-as remote-backend',
    },
    {
      id: "track",
      done: apps.length > 0,
      title: "Track an application",
      detail: "Save a role you like. Its next step and follow-ups show up under Applications.",
      href: "/",
      cli: "jobflow track add 1",
    },
  ];
  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((s) => !s.done) ?? null,
    profile: {
      onboarded,
      name,
      missing: profileReadiness(profile, evidence.length).missing,
      evidence: evidence.length,
      skills: profile.prefs.stackProfile.length,
    },
    corpus: { postings: postings.length, matches, lastSyncAt: lastPolled ? new Date(lastPolled).toISOString() : null, syncing: corpusSyncing() },
    searches: searches.length,
    applications: { total: apps.length, applied, dueFollowUps },
    model: { configured: !isOfflineProvider(llm), provider: llm.name },
  };
}
