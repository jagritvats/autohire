import { createHash, timingSafeEqual } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { parseApiToken } from "@jobflow/core";
import { DEFAULT_TENANT } from "@jobflow/pipeline";

/**
 * Which user this agent works for. On a single-user install it's the default tenant. On a
 * multi-user instance the agent must present an API token with the `agent` scope
 * (Settings › API tokens → JOBFLOW_AGENT_TOKEN), and it only ever claims, reads and
 * writes that tenant's jobs and profile — never anyone else's.
 */
let tenant: string | null = null;

export function agentTenant(): string {
  if (!tenant) throw new Error("agent tenant not resolved yet — call resolveAgentTenant() first");
  return tenant;
}

export async function resolveAgentTenant(repo: Repository): Promise<string> {
  const raw = process.env.JOBFLOW_AGENT_TOKEN?.trim();
  if (!raw) {
    if (process.env.JOBFLOW_AUTH === "password") {
      throw new Error("This is a multi-user instance: create an API token with the 'agent' scope in Settings and set JOBFLOW_AGENT_TOKEN.");
    }
    tenant = DEFAULT_TENANT;
    return tenant;
  }
  const parsed = parseApiToken(raw);
  if (!parsed) throw new Error("JOBFLOW_AGENT_TOKEN is malformed (expected jft_<id>.<secret>).");
  const tok = await repo.getApiToken(parsed.id);
  const hash = createHash("sha256").update(parsed.secret).digest();
  const stored = tok ? Buffer.from(tok.secretHash, "hex") : Buffer.alloc(0);
  const ok = !!tok && stored.length === hash.length && timingSafeEqual(stored, hash);
  if (!tok || !ok || tok.revokedAt) throw new Error("JOBFLOW_AGENT_TOKEN is invalid or revoked.");
  if (tok.expiresAt && new Date(tok.expiresAt as string | Date).getTime() < Date.now()) throw new Error("JOBFLOW_AGENT_TOKEN has expired.");
  if (!tok.scopes.includes("agent")) throw new Error("JOBFLOW_AGENT_TOKEN lacks the 'agent' scope.");
  tenant = tok.tenantId;
  return tenant;
}
