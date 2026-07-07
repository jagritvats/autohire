import { NextResponse } from "next/server";
import { TenantConfig } from "@jobflow/core";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { getRepo, ensureTenant } from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = await getRepo();
  await ensureTenant(repo);
  const config = await repo.getConfig(DEFAULT_TENANT);
  return NextResponse.json(config);
}

export async function PUT(req: Request) {
  const repo = await getRepo();
  await ensureTenant(repo);
  const current = await repo.getConfig(DEFAULT_TENANT);
  const body = await req.json();
  // validate + merge; autosubmit can never be flipped here (literal false in schema)
  const next = TenantConfig.parse({ ...current, ...body, tenantId: DEFAULT_TENANT });
  await repo.saveConfig(next);
  return NextResponse.json(next);
}
