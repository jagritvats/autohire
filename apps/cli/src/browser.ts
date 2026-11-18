import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromiumExecutablePath } from "@jobflow/autofill";

/**
 * Local-browser helpers: is Playwright (+ its Chromium) installed where the form-filler
 * will import it from, and opening a URL in the user's default browser.
 */

export interface PlaywrightStatus {
  installed: boolean;
  version: string | null;
  /** a browser the filler can launch: JOBFLOW_CHROMIUM if set, else Playwright's own Chromium */
  chromium: boolean;
  executable: string | null;
  /** where `executable` comes from */
  browserSource: "JOBFLOW_CHROMIUM" | "playwright" | null;
  /** JOBFLOW_CHROMIUM is set but names no file (the filler would fail to launch it) */
  customMissing?: string;
  error?: string;
}

export const PLAYWRIGHT_INSTALL_HINT = "pnpm add -w playwright && npx playwright install chromium";

/**
 * Playwright as @jobflow/autofill resolves it (an optional peer dep, loaded at fill time),
 * and the browser it will launch. JOBFLOW_CHROMIUM (an installed Chrome/Chromium) wins over
 * Playwright's own download, exactly as the filler's launch does — so with it set, Playwright's
 * Chromium need not be installed.
 */
export async function playwrightStatus(env: NodeJS.ProcessEnv = process.env): Promise<PlaywrightStatus> {
  let path: string;
  const none = { installed: false, version: null, chromium: false, executable: null, browserSource: null } as const;
  try {
    const from = import.meta.resolve("@jobflow/autofill");
    path = createRequire(from).resolve("playwright");
  } catch {
    try {
      path = createRequire(import.meta.url).resolve("playwright");
    } catch (e) {
      return { ...none, error: (e as Error).message.split("\n")[0] };
    }
  }
  try {
    const req = createRequire(path);
    const pkg = req(join(path, "..", "package.json")) as { version?: string };
    const version = pkg.version ?? null;
    const custom = chromiumExecutablePath(env);
    if (custom) {
      return existsSync(custom)
        ? { installed: true, version, chromium: true, executable: custom, browserSource: "JOBFLOW_CHROMIUM" }
        : { installed: true, version, chromium: false, executable: null, browserSource: null, customMissing: custom };
    }
    const pw = req(path) as { chromium?: { executablePath(): string } };
    let exe: string | null = null;
    try {
      exe = pw.chromium?.executablePath() ?? null;
    } catch {
      exe = null;
    }
    const ok = !!exe && existsSync(exe);
    return { installed: true, version, chromium: ok, executable: exe, browserSource: ok ? "playwright" : null };
  } catch (e) {
    return { ...none, error: (e as Error).message.split("\n")[0] };
  }
}

/** One line for `doctor`, plus the fix when the filler can't launch a browser. */
export function browserCheck(pw: PlaywrightStatus): { ok: boolean; detail: string; fix?: string } {
  if (!pw.installed) return { ok: false, detail: "not installed (only needed for apply --fill)", fix: PLAYWRIGHT_INSTALL_HINT };
  if (pw.customMissing) {
    return { ok: false, detail: `v${pw.version}, JOBFLOW_CHROMIUM=${pw.customMissing} doesn't exist`, fix: "point JOBFLOW_CHROMIUM at your Chrome/Chromium binary, or unset it and run: npx playwright install chromium" };
  }
  if (pw.browserSource === "JOBFLOW_CHROMIUM") return { ok: true, detail: `v${pw.version} + ${pw.executable} (JOBFLOW_CHROMIUM)` };
  if (pw.chromium) return { ok: true, detail: `v${pw.version} + chromium` };
  return { ok: false, detail: `v${pw.version}, chromium missing`, fix: "npx playwright install chromium (or set JOBFLOW_CHROMIUM to an installed Chrome)" };
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
