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

  const context = await pw.chromium.launchPersistentContext(opts.userDataDir ?? defaultProfileDir(), {
    headless: opts.headless ?? false,
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const report: FillReport = {
    filled: [],
    skippedNoField: [],
    answersMatched: [],
    reviewUrl: plan.url,
    submitted: false,
    note: "Stopped at review. Human must edit + submit.",
  };

  try {
    await page.goto(plan.url, { waitUntil: "domcontentloaded" });
    await sleep(actionDelayMs(flags));

    for (const f of plan.fields) {
      const locator = await firstVisible(page, f.selectors);
      if (!locator) {
        report.skippedNoField.push(f.field);
        continue;
      }
      if (!opts.dryRun) {
        await fillField(locator, f, flags);
      }
      report.filled.push(f.field);
      await sleep(actionDelayMs(flags));
    }

    // free-text questions: match the visible question label to our drafted answers
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
  } finally {
    // intentionally keep the context open for human review; caller closes it.
  }
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
function defaultProfileDir(): string {
  return process.env.JOBFLOW_BROWSER_PROFILE ?? ".jobflow/browser-profile";
}

// ── minimal structural types so this file type-checks without @types/playwright ──
interface PwLocator {
  first(): PwLocator;
  isVisible(opts?: { timeout?: number }): Promise<boolean>;
  fill(value: string): Promise<void>;
  setInputFiles(files: string): Promise<void>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  url(): string;
  locator(selector: string): PwLocator;
  newPage?: never;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
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
