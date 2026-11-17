import { NextResponse } from "next/server";
import { loadSampleProfile, rankTenant } from "@jobflow/service";
import { getRepo } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Replace your profile + Evidence Bank with the FICTIONAL sample candidate ("Alex Example")
 * to try JobFlow before importing your own résumé. Sample evidence is labelled, and the
 * tailor page warns before drafting from it.
 */
export async function POST(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await loadSampleProfile(repo, auth.tenantId);
  await rankTenant(repo, auth.tenantId);
  return NextResponse.json({ ok: true });
}
