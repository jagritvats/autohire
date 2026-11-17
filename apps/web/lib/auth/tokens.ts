import "server-only";
import { randomBytes } from "node:crypto";
import type { Repository } from "@jobflow/db";
import { formatApiToken, type ApiToken, type TokenScope } from "@jobflow/core";
import { sha256Hex, type AuthContext } from "./resolve";

/**
 * Issue a scoped API token for the CLI, the extension or the local agent. The plaintext is
 * returned ONCE; only sha256(secret) is stored, so a database leak can't replay it.
 */
export async function issueApiToken(
  repo: Repository,
  auth: AuthContext,
  input: { name: string; scopes: TokenScope[]; expiresDays?: number | null },
): Promise<{ token: string; meta: ApiToken }> {
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const now = new Date();
  const meta: ApiToken = {
    id,
    tenantId: auth.tenantId,
    userId: auth.userId,
    name: input.name.trim().slice(0, 80) || "token",
    scopes: [...new Set(input.scopes)],
    createdAt: now,
    lastUsedAt: null,
    expiresAt: input.expiresDays ? new Date(now.getTime() + input.expiresDays * 86_400_000) : null,
    revokedAt: null,
  };
  await repo.createApiToken({ ...meta, secretHash: sha256Hex(secret) });
  return { token: formatApiToken(id, secret), meta };
}
