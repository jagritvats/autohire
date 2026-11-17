import "server-only";
import type { PurgeOptions } from "@jobflow/db";
import * as svc from "@jobflow/service";
import { getRepo } from "./repo";

export type { FeedCard, FeedData, FeedOptions, PostingView } from "@jobflow/service";

/**
 * Web adapters over @jobflow/service — the feed logic itself is shared with the CLI and
 * worker. Every call is for ONE tenant (the authenticated caller); in multi-user mode the
 * request path never polls the shared corpus (the worker does).
 */
const bootstrap = () => process.env.JOBFLOW_AUTH !== "password";

export async function getFeed(tenantId: string, opts: svc.FeedOptions = {}) {
  return svc.getFeed(await getRepo(), tenantId, { bootstrap: bootstrap(), ...opts });
}
export async function refreshFeed(tenantId: string) {
  return svc.refreshFeed(await getRepo(), tenantId);
}
export async function rerankOnly(tenantId: string) {
  return svc.rerankOnly(await getRepo(), tenantId);
}
export async function getPostingsView(tenantId: string, view: svc.PostingView) {
  return svc.getPostingsView(await getRepo(), tenantId, view);
}
export async function recheckFeed(tenantId: string, postingIds: string[]) {
  return svc.recheckFeed(await getRepo(), tenantId, postingIds);
}
export async function purgeOldFeed(tenantId: string, opts: PurgeOptions) {
  return svc.purgeOldFeed(await getRepo(), tenantId, opts);
}
