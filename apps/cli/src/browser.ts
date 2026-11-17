import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Local-browser helpers: is Playwright (+ its Chromium) installed where the form-filler
 * will import it from, and opening a URL in the user's default browser.
 */

export interface PlaywrightStatus {
  installed: boolean;
  version: string | null;
  chromium: boolean;
  executable: string | null;
  error?: string;
}

export const PLAYWRIGHT_INSTALL_HINT = "pnpm add -w playwright && npx playwright install chromium";

/** Playwright as @jobflow/autofill resolves it (an optional peer dep, loaded at fill time). */
export async function playwrightStatus(): Promise<PlaywrightStatus> {
  let path: string;
  try {
    const from = import.meta.resolve("@jobflow/autofill");
    path = createRequire(from).resolve("playwright");
  } catch {
    try {
      path = createRequire(import.meta.url).resolve("playwright");
    } catch (e) {
      return { installed: false, version: null, chromium: false, executable: null, error: (e as Error).message.split("\n")[0] };
    }
  }
  try {
    const req = createRequire(path);
    const pkg = req(join(path, "..", "package.json")) as { version?: string };
    const pw = req(path) as { chromium?: { executablePath(): string } };
    let exe: string | null = null;
    try {
      exe = pw.chromium?.executablePath() ?? null;
    } catch {
      exe = null;
    }
    return { installed: true, version: pkg.version ?? null, chromium: !!exe && existsSync(exe), executable: exe };
  } catch (e) {
    return { installed: false, version: null, chromium: false, executable: null, error: (e as Error).message.split("\n")[0] };
  }
}

/** Open a URL in the default browser (detached — the CLI doesn't wait for it). */
export function openUrl(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
