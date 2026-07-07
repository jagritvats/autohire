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

  /**
   * Replay a site's own JSON/XHR endpoint from INSIDE a first-party page, so the
   * request rides the user's session cookies + any anti-bot clearance and can carry
   * the custom headers those internal APIs demand (e.g. Naukri's appid/systemid). This
   * is the reliable way to read a client-rendered board (§11.5) — far more robust than
   * scraping a virtualized/lazy DOM. Returns the raw response body (JSON text), or ""
   * on any failure (callers treat that as "no data", never throwing the pipeline).
   */
  async localFetchJson(url: string, headers: Record<string, string> = {}): Promise<string> {
    const origin = safeOrigin(url);
    const page = await (await this.ctx()).newPage();
    try {
      // land on the first-party origin first → same-origin fetch gets cookies + CF cookie
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await sleep(600 + Math.random() * 900);
      return await page.evaluate<string, { u: string; h: Record<string, string> }>(
        async ({ u, h }) => {
          try {
            const res = await fetch(u, { headers: h, credentials: "include" });
            return await res.text();
          } catch {
            return "";
          }
        },
        { u: url, h: headers },
      );
    } catch {
      return "";
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

/** Origin of a URL, or the URL itself if it can't be parsed (defensive). */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
