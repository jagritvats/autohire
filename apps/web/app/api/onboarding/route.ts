import { NextResponse } from "next/server";
import { z } from "zod";
import { Contact, LevelBand, ProfilePrefs, ResumeDraft, StoredFile } from "@jobflow/core";
import { finishOnboarding, onboardingStatus, rankTenant, startCorpusSync } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { getFileStore } from "@/lib/files";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Where you are in onboarding + what your profile still needs. */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const s = await onboardingStatus(await getRepo(), auth.tenantId);
  return NextResponse.json({ onboarded: s.onboarded, readiness: s.readiness, evidenceCount: s.evidenceCount });
}

const Body = z.object({
  draft: ResumeDraft.nullable().optional(),
  file: StoredFile.nullable().optional(),
  mode: z.enum(["merge", "replace"]).optional(),
  acceptEvidence: z.array(z.number().int().nonnegative()).optional(),
  contact: Contact.partial().optional(),
  prefs: ProfilePrefs.partial().optional(),
  yoe: z.number().min(0).max(60).optional(),
  levelBand: LevelBand.optional(),
  stackProfile: z.array(z.string().max(60)).max(200).optional(),
  discoveryPresets: z.array(z.string().max(40)).max(10).optional(),
  discoveryPreset: z.string().max(40).optional(),
});

/** Finish onboarding with what you confirmed; your feed is ranked right after. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid onboarding data." }, { status: 400 });
  if (!parsed.data.draft && !parsed.data.stackProfile?.length) {
    return NextResponse.json({ error: "Add your résumé or at least one skill — there's nothing to rank jobs against otherwise." }, { status: 400 });
  }
  const repo = await getRepo();
  // a stored file must be this tenant's own upload
  if (parsed.data.file && !parsed.data.file.key.startsWith(`tenants/${auth.tenantId}/`)) {
    return NextResponse.json({ error: "That file doesn't belong to you." }, { status: 403 });
  }
  const r = await finishOnboarding(repo, getFileStore(), auth.tenantId, parsed.data);
  // rank now if there's a corpus; otherwise sync first (in the background, single-user only)
  const corpus = await repo.listActivePostings();
  if (corpus.length) await rankTenant(repo, auth.tenantId);
  else if (process.env.JOBFLOW_AUTH !== "password") void startCorpusSync(repo, async () => void (await rankTenant(repo, auth.tenantId)), undefined, { trigger: "first_run" });
  return NextResponse.json(r);
}
