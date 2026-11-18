import { homedir } from "node:os";
import { join } from "node:path";
import { actionDelayMs, assertCanFill, assertNeverSubmits, readFlags, type AutomationFlags } from "./flags.js";
import type { FillPlan, PlannedField } from "./plan.js";

/**
 * Local Playwright form-filler with review gate (§7.1, layer 3). Runs in the user's
 * OWN browser profile (their session, their IP, human-paced). Fills the plan, then
 * STOPS — the page is left open for the human to review, edit, and submit. There is
 * no code path here that clicks a submit button.
 *
 * Playwright is imported dynamically so the package installs/builds without it; the
 * runner only needs it at actual run time on the local agent.
 */

export interface RunnerOptions {
  /** path to the user's browser profile dir → reuses their logged-in sessions */
  userDataDir?: string;
  headless?: boolean;
  flags?: AutomationFlags;
  /** dry-run: connect, locate fields, report — but DON'T type anything */
  dryRun?: boolean;
}

export interface FillReport {
  filled: string[];
  skippedNoField: string[];
  answersMatched: string[];
  reviewUrl: string;
  submitted: false; // always — encoded in the type
  note: string;
}

export async function runFill(plan: FillPlan, opts: RunnerOptions = {}): Promise<FillReport> {
  const flags = opts.flags ?? readFlags();
  assertCanFill(flags); // gate 1+2
  assertNeverSubmits(flags); // gate 4 (immovable)

  // dynamic import keeps playwright an optional peer dep
  const pw = await importPlaywright();

  const context = await pw.chromium.launchPersistentContext(resolveProfileDir(opts.userDataDir), {
    headless: opts.headless ?? false,
    viewport: null,
    ...chromiumExecutable(),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return fillPlanOnPage(page, plan, { flags, dryRun: opts.dryRun });
}

/**
 * Fill a plan on an ALREADY-OPEN page (the agent owns one logged-in persistent
 * context and drives jobs sequentially through it). Stops at the review gate —
 * there is no submit here, by design (gate 4 must already have been asserted).
 */
export async function fillPlanOnPage(
  page: PwPage,
  plan: FillPlan,
  opts: { flags: AutomationFlags; dryRun?: boolean },
): Promise<FillReport> {
  const { flags } = opts;
  // the agent calls this directly (not via runFill) — re-assert gate 4 here too
  assertNeverSubmits(flags);
  const report: FillReport = {
    filled: [],
    skippedNoField: [],
    answersMatched: [],
    reviewUrl: plan.url,
    submitted: false,
    note: "Stopped at review. Human must edit + submit.",
  };

  await page.goto(plan.url, { waitUntil: "domcontentloaded" });
  await sleep(actionDelayMs(flags));

  for (const f of plan.fields) {
    // file inputs are usually visually hidden behind a styled "Attach" button
    // (Greenhouse/Lever/Ashby) — they only need to be in the DOM for setInputFiles
    const locator = f.isFile ? await firstAttached(page, f.selectors) : await firstVisible(page, f.selectors);
    if (!locator) {
      report.skippedNoField.push(f.field);
      continue;
    }
    if (!opts.dryRun) await fillField(locator, f, flags);
    report.filled.push(f.field);
    await sleep(actionDelayMs(flags));
  }

  for (const q of plan.questionFields) {
    const ta = await findTextareaByLabel(page, q.question);
    if (ta) {
      if (!opts.dryRun) await ta.fill(q.answer);
      report.answersMatched.push(q.question);
      await sleep(actionDelayMs(flags));
    }
  }

  // REVIEW GATE: leave everything as-is. We do NOT submit, by design.
  report.reviewUrl = page.url();
  return report;
}

async function fillField(locator: PwLocator, f: PlannedField, _flags: AutomationFlags): Promise<void> {
  if (f.isFile) {
    await locator.setInputFiles(f.value);
  } else {
    await locator.fill(f.value);
  }
}

async function firstVisible(page: PwPage, selectors: string[]): Promise<PwLocator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 800 })) return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** First selector that matches an element in the DOM, visible or not (file inputs). */
async function firstAttached(page: PwPage, selectors: string[]): Promise<PwLocator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) > 0) return loc;
    } catch {
      /* invalid selector on this engine → try next */
    }
  }
  return null;
}

async function findTextareaByLabel(page: PwPage, question: string): Promise<PwLocator | null> {
  // match the first ~5 significant words of the question against labels
  const key = question.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
  const candidates = [
    `textarea[aria-label*="${escapeQuotes(key)}" i]`,
    `label:has-text("${escapeQuotes(question.slice(0, 40))}") ~ textarea`,
    `text=${question.slice(0, 30)} >> xpath=following::textarea[1]`,
  ];
  return firstVisible(page, candidates);
}

function escapeQuotes(s: string): string {
  return s.replace(/"/g, "");
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/**
 * The persistent browser profile (the user's logged-in sessions). Absolute and
 * independent of the cwd — a relative default meant `pnpm agent` from the repo root
 * and from apps/agent used two different profiles (and logins). Override with
 * JOBFLOW_BROWSER_PROFILE.
 */
export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveProfileDir(undefined, env);
}

/** An explicit dir (blank = unset, `~` expanded) → env → ~/.jobflow/browser-profile. */
export function resolveProfileDir(dir: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const set = dir?.trim() || env.JOBFLOW_BROWSER_PROFILE?.trim();
  if (set) return set === "~" || set.startsWith("~/") ? join(homedir(), set.slice(1)) : set;
  return join(homedir(), ".jobflow", "browser-profile");
}

/**
 * Launch the user's OWN persistent browser context (their logged-in sessions). The
 * agent owns ONE of these and drives all browser jobs through it sequentially, so
 * Tier-3 fetch and form-fill never fight over the same Chromium profile (§7.1).
 */
export async function launchUserContext(opts: { userDataDir?: string; headless?: boolean } = {}): Promise<PwContext> {
  const pw = await importPlaywright();
  return pw.chromium.launchPersistentContext(resolveProfileDir(opts.userDataDir), {
    ...chromiumExecutable(),
    headless: opts.headless ?? false,
    viewport: null,
  });
}

// ── minimal structural types so this file type-checks without @types/playwright ──
// NOTE: deliberately no click()/press()/tap()/dispatchEvent() here — the runner can't
// call what the type doesn't expose, so a submit can't sneak in (invariant #2).
export interface PwLocator {
  first(): PwLocator;
  count(): Promise<number>;
  isVisible(opts?: { timeout?: number }): Promise<boolean>;
  fill(value: string): Promise<void>;
  setInputFiles(files: string): Promise<void>;
}
export interface PwPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  close(): Promise<void>;
  locator(selector: string): PwLocator;
  /** run a function in the page context (used to replay a site's own XHR with its cookies). */
  evaluate<R, A = unknown>(pageFunction: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
}
export interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: {
    launchPersistentContext(
      dir: string,
      opts: { headless?: boolean; viewport?: null },
    ): Promise<PwContext>;
  };
}

async function importPlaywright(): Promise<PwModule> {
  try {
    // indirect specifier: playwright is an optional peer dep, resolved at runtime
    // on the local agent only — TS must not try to statically resolve it here.
    const mod = "playwright";
    return (await import(mod)) as PwModule;
  } catch {
    throw new Error(
      "playwright is not installed. The form-filler runs only on the local agent: `pnpm add playwright && npx playwright install chromium`.",
    );
  }
}

/** JOBFLOW_CHROMIUM: use an installed Chrome/Chromium instead of Playwright's own download. */
function chromiumExecutable(): { executablePath?: string } {
  const p = process.env.JOBFLOW_CHROMIUM?.trim();
  return p ? { executablePath: p } : {};
}
