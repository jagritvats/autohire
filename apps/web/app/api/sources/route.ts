import { NextResponse } from "next/server";
import { z } from "zod";
import { ProfileSourceKind } from "@jobflow/core";
import {
  listSources,
  importGithubSource,
  saveYcPaste,
  setSourceEnabled,
  removeSource,
  enqueueYcImport,
} from "@/lib/sources";

// GitHub fetch + repo writes want the node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ sources: await listSources() });
}

const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("github_import"), handle: z.string().min(1) }),
  z.object({ op: z.literal("yc_paste"), content: z.string().min(1) }),
  z.object({ op: z.literal("yc_agent"), url: z.string().url() }),
  z.object({ op: z.literal("toggle"), source: ProfileSourceKind, enabled: z.boolean() }),
  z.object({ op: z.literal("remove"), source: ProfileSourceKind }),
]);

export async function POST(req: Request) {
  const parsed = Op.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const body = parsed.data;
  try {
    switch (body.op) {
      case "github_import":
        return NextResponse.json(await importGithubSource(body.handle));
      case "yc_paste":
        return NextResponse.json(await saveYcPaste(body.content));
      case "yc_agent": {
        const jobId = await enqueueYcImport(body.url);
        return NextResponse.json({ queued: true, jobId });
      }
      case "toggle":
        await setSourceEnabled(body.source, body.enabled);
        return NextResponse.json({ ok: true });
      case "remove":
        await removeSource(body.source);
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
