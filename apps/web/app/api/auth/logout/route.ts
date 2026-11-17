import { NextResponse } from "next/server";
import { getRepo } from "@/lib/repo";
import { clearSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const repo = await getRepo();
  const cookie = await clearSession(repo, req);
  return NextResponse.json({ ok: true }, { headers: { "set-cookie": cookie } });
}
