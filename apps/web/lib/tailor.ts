import "server-only";
import * as svc from "@jobflow/service";
import { getRepo } from "./repo";

export type { DraftKind, GenerateInput, GenerationDTO } from "@jobflow/service";
export { KIND_QUESTION, PROMPT_VERSION } from "@jobflow/service";

export async function generateTailored(tenantId: string, input: svc.GenerateInput) {
  return svc.generateTailored(await getRepo(), tenantId, input);
}
export async function saveEditedDraft(tenantId: string, input: Parameters<typeof svc.saveEditedDraft>[2]) {
  return svc.saveEditedDraft(await getRepo(), tenantId, input);
}
export async function listTailored(tenantId: string, postingId?: string | null) {
  return svc.listTailored(await getRepo(), tenantId, postingId);
}
export async function clearTailored(tenantId: string, postingId?: string | null) {
  return svc.clearTailored(await getRepo(), tenantId, postingId);
}
