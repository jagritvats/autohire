import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { StoredFile } from "@jobflow/core";
import { defaultDataDir } from "./paths.js";

export type FileKind = "resume" | "tailored";
const KINDS: readonly FileKind[] = ["resume", "tailored"];

/**
 * Per-tenant storage for user files (uploaded résumés, tailored outputs), kept OUTSIDE
 * the repo tree. Keys are opaque, tenant-prefixed relative paths; the repo stores the
 * `StoredFile` (key + metadata), never the bytes.
 */
export interface FileStore {
  put(tenantId: string, kind: FileKind, filename: string, bytes: Uint8Array, mime?: string): Promise<StoredFile>;
  get(key: string): Promise<Uint8Array | null>;
  /** absolute path on local disk (for tools that need a file, e.g. the form-filler), or null. */
  localPath(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^tenants\/([A-Za-z0-9_-]{1,64})\/(resume|tailored)\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/;

/** a filename reduced to `[A-Za-z0-9._-]`, no leading dots, no directories. */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFKD");
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(-120);
  return cleaned || "file";
}

/** Files under `<root>/tenants/<tenantId>/<kind>/<sha8>-<safeName>`, mode 0600 (dirs 0700). */
export class LocalFileStore implements FileStore {
  readonly root: string;

  constructor(root = join(defaultDataDir(), "files")) {
    this.root = resolve(root);
  }

  /** key → absolute path, refusing anything that isn't a well-formed key inside root. */
  private pathFor(key: string): string {
    if (typeof key !== "string" || !KEY.test(key) || key.includes("..")) throw new Error("invalid file key");
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("invalid file key");
    return p;
  }

  async put(tenantId: string, kind: FileKind, filename: string, bytes: Uint8Array, mime?: string): Promise<StoredFile> {
    if (!SEGMENT.test(tenantId)) throw new Error("invalid tenant id");
    if (!KINDS.includes(kind)) throw new Error(`invalid file kind: ${String(kind)}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `tenants/${tenantId}/${kind}/${sha256.slice(0, 8)}-${safeFileName(filename)}`;
    const path = this.pathFor(key);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
    return {
      key,
      filename: (filename.split(/[\\/]/).pop() || "file").slice(0, 255),
      mime: mime || "application/octet-stream",
      sha256,
      bytes: bytes.byteLength,
      uploadedAt: new Date(),
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async localPath(key: string): Promise<string | null> {
    const p = this.pathFor(key);
    try {
      return (await stat(p)).isFile() ? p : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** the default store: `$JOBFLOW_DATA_DIR/files`, else `~/.jobflow/files`. */
export function createFileStore(root?: string): FileStore {
  return new LocalFileStore(root);
}
