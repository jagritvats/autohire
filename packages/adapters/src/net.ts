import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import zlib from "node:zlib";

/**
 * SSRF guard for USER-SUPPLIED URLs (custom RSS / JSON feeds): the server fetches what a
 * user typed, so it must never be pointed at itself, the private network, or a cloud
 * metadata endpoint (product plan "Custom feeds"). Every user URL goes through `safeUrl`
 * and is fetched with `safeFetchText`, which re-checks the address it actually connects
 * to (a DNS answer can change between the check and the connect — rebinding) and every
 * redirect hop, and caps the body size.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

function allowHttp(): boolean {
  return process.env.JOBFLOW_ALLOW_HTTP_FEEDS === "1";
}

/** IPv4 dotted quad → 32-bit number (null if malformed). */
function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

/** loopback, private, link-local (incl. 169.254.169.254 metadata), CGNAT, reserved… */
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n == null) return true; // unparseable → refuse
  return V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits));
}

/** IPv6 text → 8 hextets (handles "::" and an embedded dotted IPv4 tail). */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    if (n == null) return null;
    s = `${s.slice(0, -v4[1]!.length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return out.some((x) => Number.isNaN(x)) ? null : out;
}

function isBlockedV6(ip: string): boolean {
  const h = v6Hextets(ip);
  if (!h) return true;
  const [a, b] = h as [number, number, ...number[]];
  const allZeroUpTo = (k: number) => h.slice(0, k).every((x) => x === 0);
  if (allZeroUpTo(8)) return true; // ::
  if (allZeroUpTo(7) && h[7] === 1) return true; // ::1 loopback
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96): judge the v4
  const tailV4 = `${h[6]! >>> 8}.${h[6]! & 0xff}.${h[7]! >>> 8}.${h[7]! & 0xff}`;
  if (allZeroUpTo(5) && (h[5] === 0xffff || h[5] === 0)) return isBlockedV4(tailV4);
  if (a === 0x64 && b === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isBlockedV4(tailV4);
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return isBlockedV4(`${b >>> 8}.${b & 0xff}.${h[2]! >>> 8}.${h[2]! & 0xff}`); // 6to4
  return false;
}

/** true for any address a user-supplied URL must not reach. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]!);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

export interface SafeUrlOptions {
  /** DNS resolver (tests); default: every A/AAAA answer from the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
}

async function systemResolve(host: string): Promise<string[]> {
  const addrs = await dnsLookupAsync(host, { all: true, verbatim: true });
  return addrs.map((a) => a.address);
}

/** Syntax-only checks (scheme, credentials, host name) — no DNS. Throws UnsafeUrlError. */
export function checkUrlSyntax(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowHttp())) {
    throw new UnsafeUrlError(`scheme ${url.protocol} not allowed (https only${allowHttp() ? " or http" : ""})`);
  }
  if (url.username || url.password) throw new UnsafeUrlError("credentials in the URL are not allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("missing host");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isBlockedAddress(bare)) throw new UnsafeUrlError(`address ${bare} is private/reserved`);
    return url;
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError(`host ${host} is internal`);
  }
  // a single-label name resolves through the server's search domains → internal hosts
  if (!host.includes(".")) throw new UnsafeUrlError(`host ${host} is not a public name`);
  return url;
}

/**
 * Validate a user-supplied URL for a server-side fetch: https (http only with
 * JOBFLOW_ALLOW_HTTP_FEEDS=1), no credentials, a public host whose EVERY DNS answer is a
 * public address. Throws UnsafeUrlError; returns the parsed URL.
 */
export async function safeUrl(input: string | URL, opts: SafeUrlOptions = {}): Promise<URL> {
  const url = checkUrlSyntax(input);
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return url;
  let addrs: string[];
  try {
    addrs = await (opts.resolve ?? systemResolve)(bare);
  } catch {
    throw new UnsafeUrlError(`host ${bare} does not resolve`);
  }
  if (!addrs.length) throw new UnsafeUrlError(`host ${bare} does not resolve`);
  const bad = addrs.find(isBlockedAddress);
  if (bad) throw new UnsafeUrlError(`host ${bare} resolves to a private/reserved address (${bad})`);
  return url;
}

/** true/false twin of `safeUrl`. */
export async function isSafeUrl(input: string | URL, opts: SafeUrlOptions = {}): Promise<boolean> {
  return safeUrl(input, opts).then(
    () => true,
    () => false,
  );
}

/** a connect-time lookup that refuses private answers — closes the DNS-rebinding gap. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = (addresses as unknown as Array<{ address: string; family: number }>) ?? [];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (!list.length || bad) {
      return (callback as (e: Error) => void)(new UnsafeUrlError(`${hostname} resolved to a private/reserved address`));
    }
    if ((options as { all?: boolean }).all) return (callback as (e: null, a: typeof list) => void)(null, list);
    const first = list[0]!;
    (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family);
  });
};

export interface SafeFetchOptions {
  /** body cap in bytes after decompression (default 2 MiB) — larger answers are refused. */
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  maxRedirects?: number;
}

export const DEFAULT_MAX_FEED_BYTES = 2 * 1024 * 1024;

/**
 * GET a user-supplied URL as text, safely: `safeUrl` on the URL and on every redirect hop,
 * a connect-time address check, a timeout and a size cap. Throws (UnsafeUrlError or a
 * plain Error with the reason) — callers turn that into `[]` + a recorded error.
 */
export async function safeFetchText(input: string, opts: SafeFetchOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FEED_BYTES;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await safeUrl(current);
    const res = await getOnce(url, { maxBytes, timeoutMs: opts.timeoutMs ?? 20_000, accept: opts.accept });
    if (res.redirect) {
      current = new URL(res.redirect, url).toString();
      continue;
    }
    return res.body!;
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}

function getOnce(
  url: URL,
  opts: { maxBytes: number; timeoutMs: number; accept?: string },
): Promise<{ redirect?: string; body?: string }> {
  const mod = url.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      {
        lookup: guardedLookup,
        timeout: opts.timeoutMs,
        headers: {
          "User-Agent": "JobFlow/0.1 (+personal job-search; contact via app)",
          Accept: opts.accept ?? "*/*",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          return reject(new Error(`response too large (${declared} bytes > ${opts.maxBytes})`));
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          enc === "gzip" || enc === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            stream.destroy();
            reject(new Error(`response too large (> ${opts.maxBytes} bytes)`));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
        stream.on("error", (e: Error) => reject(e));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    // the socket timeout resets on every byte — a server dripping data would never trip it
    const deadline = setTimeout(() => req.destroy(new Error(`no complete answer within ${2 * opts.timeoutMs} ms`)), 2 * opts.timeoutMs);
    req.on("close", () => clearTimeout(deadline));
  });
}
