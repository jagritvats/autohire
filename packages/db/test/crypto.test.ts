import { describe, expect, it } from "vitest";
import { parseApiToken, formatApiToken } from "@jobflow/core";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  newId,
  newSecret,
  safeEqualHex,
  sha256Hex,
  verifyPassword,
} from "../src/auth/crypto.js";

const KEY = Buffer.alloc(32, 1).toString("base64");

describe("password hashing (scrypt)", () => {
  it("hashes in the self-describing format and verifies only the right password", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
    // salted: same password, different hash
    expect(await hashPassword("correct horse battery")).not.toBe(h);
  });

  it("returns false (never throws) for malformed or hostile stored values", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("x", "scrypt$abc$8$1$AAAA$AAAA")).toBe(false);
    // absurd cost parameters are refused rather than run (DoS guard)
    expect(await verifyPassword("x", `scrypt$${2 ** 30}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${"A".repeat(43)}=`)).toBe(false);
  });
});

describe("ids + secrets", () => {
  it("are base64url and fit the API-token wire format", () => {
    const id = newId();
    const secret = newSecret();
    expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret(16)).toHaveLength(22);
    expect(parseApiToken(formatApiToken(id, secret))).toEqual({ id, secret });
  });

  it("sha256Hex + safeEqualHex", () => {
    const a = sha256Hex("hello");
    expect(a).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(safeEqualHex(a, sha256Hex("hello"))).toBe(true);
    expect(safeEqualHex(a, a.toUpperCase())).toBe(true);
    expect(safeEqualHex(a, sha256Hex("hellO"))).toBe(false);
    expect(safeEqualHex(a, a.slice(2))).toBe(false);
    expect(safeEqualHex(a, null)).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
  });
});

describe("secrets at rest (AES-256-GCM)", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const enc = encryptSecret("sk-ant-very-secret", KEY);
    expect(enc).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(enc).not.toContain("sk-ant");
    expect(decryptSecret(enc, KEY)).toBe("sk-ant-very-secret");
    expect(encryptSecret("sk-ant-very-secret", KEY)).not.toBe(enc);
    expect(decryptSecret(encryptSecret("", KEY), KEY)).toBe("");
  });

  it("throws on tampering, a wrong key, a truncated tag or a bad key size", () => {
    const enc = encryptSecret("payload", KEY);
    const [v, iv, tag, ct] = enc.split(":") as [string, string, string, string];
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64url");
      b[0] = b[0]! ^ 1;
      return b.toString("base64url");
    };
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join(":"), KEY)).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), ct].join(":"), KEY)).toThrow();
    expect(() => decryptSecret([v, flip(iv), tag, ct].join(":"), KEY)).toThrow();
    expect(() => decryptSecret([v, iv, Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url"), ct].join(":"), KEY)).toThrow();
    expect(() => decryptSecret(enc, Buffer.alloc(32, 2).toString("base64"))).toThrow();
    expect(() => decryptSecret("v2:a:b:c", KEY)).toThrow(/format/);
    expect(() => encryptSecret("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
