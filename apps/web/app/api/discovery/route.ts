import { NextResponse } from "next/server";
import { z } from "zod";
import {
  addCompany,
  addSource,
  listDiscovery,
  removeDiscoverySource,
  setPreset,
  setPresetFeed,
  setSourceEnabledById,
} from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Your discovery setup: the built-in presets (and which feeds are on) + your own sources. */
export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  return NextResponse.json(await listDiscovery(await getRepo(), auth.tenantId));
}

const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("preset"), id: z.string().max(40) }),
  z.object({ op: z.literal("preset_feed"), feedId: z.string().max(80), enabled: z.boolean() }),
  z.object({ op: z.literal("add"), label: z.string().max(120).optional(), config: z.unknown() }),
  z.object({ op: z.literal("toggle"), id: z.string().uuid(), enabled: z.boolean() }),
  z.object({ op: z.literal("remove"), id: z.string().uuid() }),
  z.object({ op: z.literal("company"), name: z.string().max(120).optional(), careersUrl: z.string().url().max(500).optional() }),
]);

/** Change your discovery: pick a preset, toggle its feeds, add/remove your own sources. */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const parsed = Op.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const repo = await getRepo();
  const b = parsed.data;
  try {
    if (b.op === "preset") await setPreset(repo, auth.tenantId, b.id);
    else if (b.op === "preset_feed") await setPresetFeed(repo, auth.tenantId, b.feedId, b.enabled);
    else if (b.op === "add") return NextResponse.json({ source: await addSource(repo, auth.tenantId, { label: b.label, config: b.config }) });
    else if (b.op === "toggle") await setSourceEnabledById(repo, auth.tenantId, b.id, b.enabled);
    else if (b.op === "remove") await removeDiscoverySource(repo, auth.tenantId, b.id);
    else if (b.op === "company") return NextResponse.json(await addCompany(repo, auth.tenantId, b));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
