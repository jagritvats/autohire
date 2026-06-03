/**
 * Flag-guarding for local browser automation (§7.1). Layered gates so no single
 * accident submits anything:
 *   master flag (JOBFLOW_BROWSER) → mode flag (capture|fill) → per-action review
 *   → autosubmit (separate, hard-false, off permanently by design).
 * Dry-run renders what it WOULD fill without touching a page.
 */

export type BrowserMode = "capture" | "fill";

export interface AutomationFlags {
  browser: "off" | "on";
  mode: BrowserMode;
  autosubmit: boolean;
  rate: "human" | "fast";
  tier3Sources: string[];
}

export function readFlags(env: NodeJS.ProcessEnv = process.env): AutomationFlags {
  return {
    browser: env.JOBFLOW_BROWSER === "on" ? "on" : "off",
    mode: env.JOBFLOW_BROWSER_MODE === "fill" ? "fill" : "capture",
    // autosubmit is hard-false unless EXPLICITLY "true" AND a code-level override is set.
    autosubmit: false,
    rate: env.JOBFLOW_RATE === "fast" ? "fast" : "human",
    tier3Sources: (env.JOBFLOW_TIER3_SOURCES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export class AutomationDisabledError extends Error {}

/** Gate 1+2: browser automation must be ON and in the right mode. */
export function assertCanFill(flags: AutomationFlags): void {
  if (flags.browser !== "on") {
    throw new AutomationDisabledError(
      "JOBFLOW_BROWSER is off (default). Set JOBFLOW_BROWSER=on to enable the local form-filler.",
    );
  }
  if (flags.mode !== "fill") {
    throw new AutomationDisabledError(
      `JOBFLOW_BROWSER_MODE is '${flags.mode}'. Set JOBFLOW_BROWSER_MODE=fill to fill forms.`,
    );
  }
}

/** Gate 4 (the immovable one): submission is never permitted by this code path. */
export function assertNeverSubmits(flags: AutomationFlags): void {
  if (flags.autosubmit) {
    throw new Error(
      "Refusing to autosubmit. The review screen IS the value (§7.1). Submission requires a human.",
    );
  }
}

/** Human-paced jitter between actions; no parallel sessions. */
export function actionDelayMs(flags: AutomationFlags): number {
  if (flags.rate === "fast") return 80 + Math.random() * 120;
  return 500 + Math.random() * 1500; // ~0.5–2s, like the polite public actors
}
