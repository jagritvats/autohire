import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_TENANT, defaultProfile } from "@jobflow/pipeline";
import type { Profile } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";
import { rerankOnly } from "@/lib/feed";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = await getRepo();
  await ensureTenant(repo);
  const profile = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();
  return NextResponse.json(profile);
}

// Editable subset of the profile (the rest of matching reads these, §6.1).
const Patch = z.object({
  yoe: z.number().optional(),
  levelBand: z.string().optional(),
  masterResume: z.string().optional(),
  resumeLatex: z.string().optional(),
  aboutText: z.string().optional(),
  prefs: z
    .object({
      salaryFloor: z.number().optional(),
      currency: z.string().optional(),
      stackProfile: z.array(z.string()).optional(),
      targetArchetypes: z.array(z.string()).optional(),
      remoteGeoOk: z.array(z.string()).optional(),
      relocate: z.boolean().optional(),
      locationWeights: z.array(z.object({ label: z.string(), weight: z.number() })).optional(),
      contact: z
        .object({
          firstName: z.string(), lastName: z.string(), email: z.string(),
          phone: z.string(), linkedin: z.string(), github: z.string(),
          portfolio: z.string(), resumePath: z.string(),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export async function PUT(req: Request) {
  const repo = await getRepo();
  await ensureTenant(repo);
  const body = Patch.parse(await req.json());
  const current = (await repo.getProfile(DEFAULT_TENANT)) ?? defaultProfile();

  const resumeChanged = body.masterResume !== undefined && body.masterResume !== current.masterResume;
  const next: Profile = {
    ...current,
    yoe: body.yoe ?? current.yoe,
    levelBand: (body.levelBand as Profile["levelBand"]) ?? current.levelBand,
    masterResume: body.masterResume ?? current.masterResume,
    resumeLatex: body.resumeLatex ?? current.resumeLatex,
    aboutText: body.aboutText ?? current.aboutText,
    // changing the stack or the resume invalidates the cached embedding → recompute on next rank
    profileEmbedding: body.prefs?.stackProfile || resumeChanged ? null : current.profileEmbedding,
    prefs: {
      ...current.prefs,
      ...(body.prefs ?? {}),
      contact: { ...current.prefs.contact, ...(body.prefs?.contact ?? {}) },
    } as Profile["prefs"],
  };
  await repo.saveProfile(next);

  // a settings change re-ranks (no re-poll needed)
  const feed = await rerankOnly();
  return NextResponse.json({ profile: next, feed });
}
