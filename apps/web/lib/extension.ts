import "server-only";
import * as svc from "@jobflow/service";
import { getRepo } from "./repo";

export type { PageCapture, ScoreResult, CaptureResult } from "@jobflow/service";
export { identifyPage } from "@jobflow/service";

export async function scorePage(tenantId: string, page: svc.PageCapture) {
  return svc.scorePage(await getRepo(), tenantId, page);
}
export async function capturePage(tenantId: string, page: svc.PageCapture) {
  return svc.capturePage(await getRepo(), tenantId, page);
}
