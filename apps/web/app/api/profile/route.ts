import { NextResponse } from "next/server";
import { z } from "zod";
import { blankProfile } from "@jobflow/pipeline";
import type { Profile } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";
import { rerankOnly } from "@/lib/feed";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const profile = (await repo.getProfile(auth.tenantId)) ?? blankProfile(auth.tenantId);
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
      salaryFloor: z.number().min(0).optional(),
      homeCountry: z.string().regex(/^([A-Z]{2})?$/, "home country is a 2-letter code like US or DE").optional(),
      markets: z.array(z.string().regex(/^[A-Z]{2}$/, "markets are 2-letter country codes")).optional(),
      currency: z.string().optional(),
      /** "show pay in": auto (home currency) | none | an ISO code; per year or month */
      display: z
        .object({
          currency: z.string().regex(/^(auto|none|[A-Z]{3})$/, "display currency is auto, none or a 3-letter code like USD"),
          period: z.enum(["year", "month"]),
        })
        .partial()
        .optional(),
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
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile." }, { status: 400 });
  const body = parsed.data;
  const current = (await repo.getProfile(auth.tenantId)) ?? blankProfile(auth.tenantId);

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
      display: { ...current.prefs.display, ...(body.prefs?.display ?? {}) },
    } as Profile["prefs"],
  };
  await repo.saveProfile(next);

  // a settings change re-ranks (no re-poll needed)
  const feed = await rerankOnly(auth.tenantId);
  return NextResponse.json({ profile: next, feed });
}
