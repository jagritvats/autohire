import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { InMemoryRepository } from "@jobflow/db";
import { formatApiToken } from "@jobflow/core";
import { DEFAULT_TENANT } from "@jobflow/pipeline";
import { isFailure, originAllowed, resolveAuth, type AuthInput } from "../lib/auth/resolve";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base: AuthInput = {
  mode: "none",
  method: "GET",
  url: "http://localhost:3000/api/postings",
  host: "localhost:3000",
  origin: null,
  cookie: null,
  authorization: null,
};

describe("resolveAuth — single-user (JOBFLOW_AUTH=none)", () => {
  it("answers loopback requests as the default tenant", async () => {
    const r = await resolveAuth(new InMemoryRepository(), base);
    expect(isFailure(r)).toBe(false);
    if (!isFailure(r)) expect(r.tenantId).toBe(DEFAULT_TENANT);
  });

  it("refuses a non-loopback Host (DNS rebinding / LAN exposure)", async () => {
    const r = await resolveAuth(new InMemoryRepository(), { ...base, host: "evil.example:3000" });
    expect(isFailure(r) && r.status).toBe(403);
  });

  it("refuses a cross-site POST, even a text/plain one that skips preflight", async () => {
    const r = await resolveAuth(new InMemoryRepository(), { ...base, method: "POST", origin: "https://evil.example" });
    expect(isFailure(r) && r.status).toBe(403);
  });

  it("allows same-origin and extension POSTs, and non-browser clients with no Origin", async () => {
    const repo = new InMemoryRepository();
    for (const origin of ["http://localhost:3000", "chrome-extension://abcdef", null]) {
      const r = await resolveAuth(repo, { ...base, method: "POST", origin });
      expect(isFailure(r)).toBe(false);
    }
  });

  it("allows a non-loopback host only when the operator trusts the network", async () => {
    const r = await resolveAuth(new InMemoryRepository(), { ...base, host: "10.0.0.5:3000", trustNetwork: true });
    expect(isFailure(r)).toBe(false);
  });
});

describe("resolveAuth — multi-user (JOBFLOW_AUTH=password)", () => {
  const pw: AuthInput = { ...base, mode: "password", host: "jobs.example.com", url: "https://jobs.example.com/api/postings" };

  async function seed() {
    const repo = new InMemoryRepository();
    const tenant = await repo.createTenant({ name: "a" });
    const user = await repo.createUser({ tenantId: tenant.id, email: "a@example.com", passwordHash: null, role: "member" });
    const now = new Date();
    await repo.createSession({
      id: "sess1", userId: user.id, tenantId: tenant.id, createdAt: now, lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000), userAgent: null, secretHash: sha("secret-session"),
    });
    await repo.createApiToken({
      id: "tok123", tenantId: tenant.id, userId: user.id, name: "cli", scopes: ["cli"], createdAt: now,
      lastUsedAt: null, expiresAt: null, revokedAt: null, secretHash: sha("s".repeat(32)),
    });
    return { repo, tenant, user };
  }

  it("requires a session or token", async () => {
    const r = await resolveAuth(new InMemoryRepository(), pw);
    expect(isFailure(r) && r.status).toBe(401);
  });

  it("resolves a valid session cookie to its tenant", async () => {
    const { repo, tenant } = await seed();
    const r = await resolveAuth(repo, { ...pw, cookie: "jf_session=sess1.secret-session" });
    expect(!isFailure(r) && r.tenantId).toBe(tenant.id);
  });

  it("rejects a session with the wrong secret", async () => {
    const { repo } = await seed();
    const r = await resolveAuth(repo, { ...pw, cookie: "jf_session=sess1.forged" });
    expect(isFailure(r)).toBe(true);
  });

  it("rejects a cross-site state change even with a valid session", async () => {
    const { repo } = await seed();
    const r = await resolveAuth(repo, { ...pw, method: "POST", origin: "https://evil.example", cookie: "jf_session=sess1.secret-session" });
    expect(isFailure(r) && r.status).toBe(403);
  });

  it("resolves a bearer token with its scopes; revoked tokens fail", async () => {
    const { repo, tenant } = await seed();
    const auth = `Bearer ${formatApiToken("tok123", "s".repeat(32))}`;
    const r = await resolveAuth(repo, { ...pw, authorization: auth });
    expect(!isFailure(r) && r.tenantId).toBe(tenant.id);
    expect(!isFailure(r) && [...r.scopes]).toEqual(["cli"]);
    await repo.revokeApiToken(tenant.id, "tok123");
    expect(isFailure(await resolveAuth(repo, { ...pw, authorization: auth }))).toBe(true);
  });

  it("never lets one tenant revoke another tenant's token", async () => {
    const { repo } = await seed();
    const other = await repo.createTenant({ name: "b" });
    expect(await repo.revokeApiToken(other.id, "tok123")).toBe(false);
  });
});

describe("originAllowed", () => {
  it("lets safe methods through and blocks the opaque 'null' origin on writes", () => {
    expect(originAllowed({ method: "GET", origin: "https://evil.example", host: "localhost" }, false)).toBe(true);
    expect(originAllowed({ method: "POST", origin: "null", host: "localhost" }, true)).toBe(false);
  });
});
