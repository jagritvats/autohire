import "server-only";
import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, importGithub, parseLinkedinFiles, type ImportedContext } from "@jobflow/pipeline";
import { JOB_RUNTIME, type ConnectedContext, type ProfileSourceKind } from "@jobflow/core";
import { getRepo, ensureTenant } from "./repo.js";

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

export async function listSources(): Promise<SourceDTO[]> {
  const repo = await getRepo();
  await ensureTenant(repo);
  return (await repo.listContexts(DEFAULT_TENANT)).map(toDTO);
}

/** Persist an imported payload into the (tenant, source) slot, keeping its row id. */
async function persist(source: ProfileSourceKind, imported: ImportedContext): Promise<SourceDTO> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const existing = await repo.getContext(DEFAULT_TENANT, source);
  const ctx: ConnectedContext = {
    id: existing?.id ?? randomUUID(),
    tenantId: DEFAULT_TENANT,
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

export async function importGithubSource(handle: string): Promise<SourceDTO> {
  return persist("github", await importGithub(handle));
}

export async function importLinkedinSource(files: { name: string; text: string }[]): Promise<SourceDTO> {
  return persist("linkedin", parseLinkedinFiles(files));
}

/** YC / Work-at-a-Startup is auth-gated (Tier 3) — the cloud never scrapes it; you
 *  paste it (or the local agent imports it via the import_yc job). */
export async function saveYcPaste(content: string, handle = "profile"): Promise<SourceDTO> {
  return persist("yc", { handle, label: "YC / Work at a Startup", content: content.trim(), items: [] });
}

export async function setSourceEnabled(source: ProfileSourceKind, enabled: boolean): Promise<void> {
  const repo = await getRepo();
  await ensureTenant(repo);
  await repo.setContextEnabled(DEFAULT_TENANT, source, enabled);
}

export async function removeSource(source: ProfileSourceKind): Promise<void> {
  const repo = await getRepo();
  await ensureTenant(repo);
  await repo.deleteContext(DEFAULT_TENANT, source);
}

/** Dispatch a Tier-3 YC import to the local agent (runs in YOUR session, never here). */
export async function enqueueYcImport(url: string): Promise<string> {
  const repo = await getRepo();
  await ensureTenant(repo);
  const job = await repo.enqueueJob({
    tenantId: DEFAULT_TENANT,
    type: "import_yc",
    runtime: JOB_RUNTIME.import_yc,
    payload: { url },
  });
  return job.id;
}
