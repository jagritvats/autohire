import "server-only";
import * as svc from "@jobflow/service";
import type { ProfileSourceKind } from "@jobflow/core";
import { getRepo } from "./repo";

export type { SourceDTO } from "@jobflow/service";

export async function listSources(tenantId: string) {
  return svc.listSources(await getRepo(), tenantId);
}
export async function importGithubSource(tenantId: string, handle: string) {
  return svc.importGithubSource(await getRepo(), tenantId, handle);
}
export async function importLinkedinSource(tenantId: string, files: { name: string; text: string }[]) {
  return svc.importLinkedinSource(await getRepo(), tenantId, files);
}
export async function saveYcPaste(tenantId: string, content: string, handle?: string) {
  return svc.saveYcPaste(await getRepo(), tenantId, content, handle);
}
export async function setSourceEnabled(tenantId: string, source: ProfileSourceKind, enabled: boolean) {
  return svc.setSourceEnabled(await getRepo(), tenantId, source, enabled);
}
export async function removeSource(tenantId: string, source: ProfileSourceKind) {
  return svc.removeSource(await getRepo(), tenantId, source);
}
export async function enqueueYcImport(tenantId: string, url: string) {
  return svc.enqueueYcImport(await getRepo(), tenantId, url);
}
