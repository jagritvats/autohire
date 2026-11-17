import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalFileStore, safeFileName } from "../src/files.js";

const T = "00000000-0000-0000-0000-000000000001";
const dirs: string[] = [];
function store(): LocalFileStore {
  const d = mkdtempSync(join(tmpdir(), "jobflow-files-"));
  dirs.push(d);
  return new LocalFileStore(join(d, "files"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("LocalFileStore", () => {
  it("round-trips bytes under tenants/<id>/<kind>/<sha8>-<name> with private permissions", async () => {
    const fs = store();
    const bytes = new TextEncoder().encode("%PDF-1.7 hello");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const f = await fs.put(T, "resume", "My CV (final).pdf", bytes, "application/pdf");
    expect(f).toMatchObject({ filename: "My CV (final).pdf", mime: "application/pdf", sha256: sha, bytes: bytes.length });
    expect(f.key).toBe(`tenants/${T}/resume/${sha.slice(0, 8)}-My_CV_final_.pdf`);
    expect(await fs.get(f.key)).toEqual(bytes);
    const p = await fs.localPath(f.key);
    expect(p).toBe(join(fs.root, ...f.key.split("/")));
    expect(statSync(p!).mode & 0o777).toBe(0o600);
    expect(statSync(join(fs.root, "tenants", T)).mode & 0o777).toBe(0o700);

    await fs.delete(f.key);
    expect(await fs.get(f.key)).toBeNull();
    expect(await fs.localPath(f.key)).toBeNull();
    await fs.delete(f.key); // idempotent
  });

  it("neutralizes path traversal in filenames, tenant ids and keys", async () => {
    const fs = store();
    const f = await fs.put(T, "tailored", "../../../etc/passwd", new Uint8Array([1, 2, 3]));
    expect(f.key).toMatch(new RegExp(`^tenants/${T}/tailored/[0-9a-f]{8}-passwd$`));
    expect((await fs.localPath(f.key))!.startsWith(fs.root + sep)).toBe(true);
    expect(f.filename).toBe("passwd");

    await expect(fs.put("../evil", "resume", "x.pdf", new Uint8Array([1]))).rejects.toThrow(/tenant/);
    await expect(fs.put(T, "../x" as "resume", "x.pdf", new Uint8Array([1]))).rejects.toThrow(/kind/);
    for (const bad of [
      "../../etc/passwd",
      `tenants/${T}/resume/../../../../etc/passwd`,
      `tenants/${T}/resume/..`,
      `tenants/../resume/x`,
      `/etc/passwd`,
      `tenants/${T}/other/x`,
      `tenants/${T}/resume/.hidden`,
    ]) {
      await expect(fs.get(bad), bad).rejects.toThrow(/invalid file key/);
      await expect(fs.delete(bad), bad).rejects.toThrow(/invalid file key/);
    }
    // nothing escaped the root
    expect(readdirSync(join(fs.root, "..")).sort()).toEqual(["files"]);
    expect(existsSync(join(fs.root, "tenants", T, "tailored"))).toBe(true);
  });

  it("safeFileName keeps a usable name", () => {
    expect(safeFileName("résumé 2026.docx")).toBe("re_sume_2026.docx");
    expect(safeFileName("..")).toBe("file");
    expect(safeFileName("C:\\Users\\me\\cv.pdf")).toBe("cv.pdf");
    expect(safeFileName(".env")).toBe("env");
  });
});
