import { randomUUID } from "node:crypto";
import { importGithub, parseLinkedinFiles, type ImportedContext } from "@jobflow/pipeline";
import type { Repository } from "@jobflow/db";
import { JOB_RUNTIME, type ConnectedContext, type ProfileSourceKind } from "@jobflow/core";
import { ensureTenant } from "./tenant.js";

/**
 * Connected-context orchestration (§ Customize). Mirrors tailor.ts/feed.ts — the web
 * composes the @jobflow/pipeline importers + the repo. Tier boundary (invariant #1):
 * GitHub is fetched here (Tier 1); LinkedIn is parsed from an uploaded export (no
 * scraping); YC is auth-gated → pasted, or imported by the LOCAL agent (import_yc job).
 */

/** Client-facing shape — content is summarised so the settings list stays light. */
export interface SourceDTO {
  source: ProfileSourceKind;
  label: string;
  handle: string;
  enabled: boolean;
  itemCount: number;
  preview: string;
  /** structured items (repos / positions) — used to promote into the Evidence Bank. */
  items: Record<string, unknown>[];
  syncedAt: string;
}

function toDTO(c: ConnectedContext): SourceDTO {
  return {
    source: c.source,
    label: c.label,
    handle: c.handle,
    enabled: c.enabled,
    itemCount: c.items.length,
    preview: c.content.slice(0, 600),
    items: c.items,
    syncedAt: new Date(c.syncedAt as string | Date).toISOString(),
  };
}

export async function listSources(repo: Repository, tenantId: string): Promise<SourceDTO[]> {
  await ensureTenant(repo, tenantId);
  return (await repo.listContexts(tenantId)).map(toDTO);
}

/** Persist an imported payload into the (tenant, source) slot, keeping its row id. */
async function persist(repo: Repository, tenantId: string, source: ProfileSourceKind, imported: ImportedContext): Promise<SourceDTO> {
  await ensureTenant(repo, tenantId);
  const existing = await repo.getContext(tenantId, source);
  const ctx: ConnectedContext = {
    id: existing?.id ?? randomUUID(),
    tenantId: tenantId,
    source,
    handle: imported.handle,
    label: imported.label,
    content: imported.content,
    items: imported.items,
    enabled: existing?.enabled ?? true,
    syncedAt: new Date(),
  };
  await repo.upsertContext(ctx);
  return toDTO(ctx);
}

export async function importGithubSource(repo: Repository, tenantId: string, handle: string): Promise<SourceDTO> {
  return persist(repo, tenantId, "github", await importGithub(handle));
}

export async function importLinkedinSource(repo: Repository, tenantId: string, files: { name: string; text: string }[]): Promise<SourceDTO> {
  return persist(repo, tenantId, "linkedin", parseLinkedinFiles(files));
}

/** YC / Work-at-a-Startup is auth-gated (Tier 3) — the cloud never scrapes it; you
 *  paste it (or the local agent imports it via the import_yc job). */
export async function saveYcPaste(repo: Repository, tenantId: string, content: string, handle = "profile"): Promise<SourceDTO> {
  return persist(repo, tenantId, "yc", { handle, label: "YC / Work at a Startup", content: content.trim(), items: [] });
}

export async function setSourceEnabled(repo: Repository, tenantId: string, source: ProfileSourceKind, enabled: boolean): Promise<void> {
  await ensureTenant(repo, tenantId);
  await repo.setContextEnabled(tenantId, source, enabled);
}

export async function removeSource(repo: Repository, tenantId: string, source: ProfileSourceKind): Promise<void> {
  await ensureTenant(repo, tenantId);
  await repo.deleteContext(tenantId, source);
}

/** Dispatch a Tier-3 YC import to the local agent (runs in YOUR session, never here). */
export async function enqueueYcImport(repo: Repository, tenantId: string, url: string): Promise<string> {
  await ensureTenant(repo, tenantId);
  const job = await repo.enqueueJob({
    tenantId: tenantId,
    type: "import_yc",
    runtime: JOB_RUNTIME.import_yc,
    payload: { url },
  });
  return job.id;
}
