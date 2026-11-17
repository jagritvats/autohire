import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Auth + secret-at-rest primitives (node:crypto only — no native deps, runs anywhere
 * Node does). Password hashes are self-describing (`scrypt$N$r$p$salt$hash`) so the
 * cost can be raised later without invalidating stored hashes.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;
// scrypt needs ~128·N·r bytes; node's default maxmem (32 MiB) is exactly that for N=2^15,r=8
// and is rejected, so allow headroom. Upper bounds stop a tampered hash from DoS-ing us.
const MAX_N = 1 << 20;
const maxmemFor = (N: number, r: number) => 128 * N * r * 2;

function scryptAsync(pw: string, salt: Buffer, keylen: number, o: ScryptOptions): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(pw.normalize("NFKC"), salt, keylen, o, (err, key) => (err ? rej(err) : res(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltBytes);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scryptAsync(pw, salt, keylen, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** constant-time check; false (never throws) for a malformed or foreign stored value. */
export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (!salt.length || expected.length < 16 || expected.length > 128) return false;
  try {
    const actual = await scryptAsync(pw, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** random secret, base64url (32 bytes → 43 chars). */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** short random id, base64url (9 bytes → 12 chars) — session / API-token ids. */
export function newId(bytes = 9): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

/** constant-time equality of two hex digests; false on length/format mismatch. */
export function safeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length || a.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ── secrets at rest: AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>` (base64url parts) ──

function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("JOBFLOW_SECRET_KEY must be 32 bytes, base64-encoded (generate one: openssl rand -base64 32)");
  }
  return key;
}

export function encryptSecret(plain: string, keyB64: string): string {
  const key = keyFrom(keyB64);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

/** throws on a wrong key, a tampered value or an unknown format. */
export function decryptSecret(enc: string, keyB64: string): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unrecognized encrypted secret format");
  const key = keyFrom(keyB64);
  // pin the tag length: GCM would otherwise accept a truncated (forgeable) tag
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(parts[2]!, "base64url"));
  return Buffer.concat([d.update(Buffer.from(parts[3]!, "base64url")), d.final()]).toString("utf8");
}
