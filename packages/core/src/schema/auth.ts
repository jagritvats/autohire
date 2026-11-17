import { z } from "zod";
import { TenantConfig } from "./entities.js";

/**
 * Accounts, sessions and API tokens (per-user capability). Two modes:
 * - `none`     — single-user self-host: every request is the default tenant, but only from
 *                loopback + same-origin (the app is a localhost tool).
 * - `password` — multi-user: email + scrypt password, httpOnly session cookie, scoped tokens.
 * Secrets (password hashes, session/token secrets) never appear in these shapes.
 */
export const AuthMode = z.enum(["none", "password"]);
export type AuthMode = z.infer<typeof AuthMode>;

export const UserRole = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;

/** What a token may do: the browser extension, the local agent, or the CLI (remote mode). */
export const TokenScope = z.enum(["extension", "agent", "cli"]);
export type TokenScope = z.infer<typeof TokenScope>;

const uuid = z.string().uuid();
const ts = z.union([z.string().datetime({ offset: true }), z.date()]);

export const Tenant = z.object({
  id: uuid,
  name: z.string(),
  createdAt: ts,
  lastActiveAt: ts.nullable().default(null),
});
export type Tenant = z.infer<typeof Tenant>;

export const User = z.object({
  id: uuid,
  tenantId: uuid,
  email: z.string(),
  role: UserRole.default("member"),
  externalId: z.string().nullable().default(null),
  createdAt: ts,
  disabledAt: ts.nullable().default(null),
});
export type User = z.infer<typeof User>;

export const Session = z.object({
  id: z.string(),
  userId: uuid,
  tenantId: uuid,
  createdAt: ts,
  lastSeenAt: ts,
  expiresAt: ts,
  userAgent: z.string().nullable().default(null),
});
export type Session = z.infer<typeof Session>;

export const ApiToken = z.object({
  id: z.string(),
  tenantId: uuid,
  userId: uuid.nullable().default(null),
  name: z.string(),
  scopes: z.array(TokenScope),
  createdAt: ts,
  lastUsedAt: ts.nullable().default(null),
  expiresAt: ts.nullable().default(null),
  revokedAt: ts.nullable().default(null),
});
export type ApiToken = z.infer<typeof ApiToken>;

export const SignupInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
});
export type SignupInput = z.infer<typeof SignupInput>;
export const LoginInput = z.object({ email: z.string().max(254), password: z.string().max(200) });
export type LoginInput = z.infer<typeof LoginInput>;

/** What the browser may see of a tenant's config — the LLM key is write-only. */
export const TenantConfigPublic = TenantConfig.omit({ llmApiKey: true }).extend({
  llmApiKeySet: z.boolean(),
});
export type TenantConfigPublic = z.infer<typeof TenantConfigPublic>;

export function toPublicConfig(c: TenantConfig): TenantConfigPublic {
  const { llmApiKey, ...rest } = c;
  return { ...rest, llmApiKeySet: !!llmApiKey };
}

/** API token wire format: `jft_<id>.<secret>`; only sha256(secret) is stored. */
export const API_TOKEN_PREFIX = "jft_";

export function formatApiToken(id: string, secret: string): string {
  return `${API_TOKEN_PREFIX}${id}.${secret}`;
}

export function parseApiToken(raw: string | null | undefined): { id: string; secret: string } | null {
  if (!raw) return null;
  const t = raw.trim().replace(/^Bearer\s+/i, "");
  if (!t.startsWith(API_TOKEN_PREFIX)) return null;
  const body = t.slice(API_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  const id = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return null;
  return { id, secret };
}
