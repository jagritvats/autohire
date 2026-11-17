import { NextResponse } from "next/server";
import { TenantConfig, toPublicConfig } from "@jobflow/core";
import { getRepo, ensureTenant } from "@/lib/repo";
import { guard } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const config = await repo.getConfig(auth.tenantId);
  // the LLM key is write-only: the browser learns whether one is set, never its value
  return NextResponse.json(config ? toPublicConfig(config) : null);
}

export async function PUT(req: Request) {
  const auth = await guard(req);
  if (auth instanceof Response) return auth;
  const repo = await getRepo();
  await ensureTenant(repo, auth.tenantId);
  const current = await repo.getConfig(auth.tenantId);
  const { llmApiKey, llmApiKeyClear, llmApiKeySet: _set, ...body } = (await req.json()) as Record<string, unknown>;
  // a blank key field means "keep the saved key"; clearing it is explicit
  const key = llmApiKeyClear === true ? "" : typeof llmApiKey === "string" && llmApiKey.trim() ? llmApiKey.trim() : (current?.llmApiKey ?? "");
  // validate + merge; autosubmit can never be flipped here (literal false in schema)
  const next = TenantConfig.parse({ ...current, ...body, llmApiKey: key, tenantId: auth.tenantId });
  await repo.saveConfig(next);
  return NextResponse.json(toPublicConfig(next));
}
