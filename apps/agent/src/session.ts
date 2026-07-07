import { launchUserContext, type PwContext, type PwPage } from "@jobflow/autofill";

/**
 * Owns the single logged-in browser context for the local agent. Lazily launched on
 * first browser job (so the agent boots — and heartbeats — without Playwright/Chromium
 * installed). Jobs run sequentially, so one context safely serves both Tier-3 fetch
 * and form-fill without profile conflicts.
 */
export class AgentSession {
  private context: PwContext | null = null;
  constructor(private userDataDir?: string) {}

  private async ctx(): Promise<PwContext> {
    if (!this.context) {
      this.context = await launchUserContext({ userDataDir: this.userDataDir, headless: false });
    }
    return this.context;
  }

  /** New page in the user's session — for form-fill (left open for review). */
  async newPage(): Promise<PwPage> {
    return (await this.ctx()).newPage();
  }

  /** Fetch a page's rendered HTML in the user's session (Tier-3 read), then close it. */
  async localFetch(url: string): Promise<string> {
    const page = await (await this.ctx()).newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await sleep(800 + Math.random() * 1200); // let client-rendered content settle
      return await page.content();
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
