// Three vertical reels (1080×1920): a hook card, fast cuts of the real UI at phone width
// (360 px recorded at 3×), big word-by-word captions burned in (kept between y≈250 and
// y≈1480, clear of the platforms' UI), and an end card. Narration: narration/reels.json.
import { CARD, card, chat, conversation, endCard, fillForm, hideChecklist, idOf, load, note, scrollToEl, sleep, smoothScroll, spotlight } from "./_common.mjs";

const MOBILE = { width: 360, height: 640, scale: 3, mobile: true };
const SIZE = { w: 1080, h: 1920 };
const vcard = (d) => card({ vertical: true, ...d });
const vend = () => endCard({ vertical: true, pills: ["AGPL-3.0", "local-first", "never submits"] });
const base = {
  size: SIZE,
  outSub: "reels",
  burnWords: { w: 1080, h: 1920, size: 86, marginV: 440, perCue: 3 },
  posterAt: 1.4,
  musicVolume: 0.2,
  defaults: { pre: 0.15, gap: 0.2, post: 0.3 },
};
const liveFeed = (run, setup) => ({
  kind: "live",
  url: "/",
  view: MOBILE,
  chapter: false,
  cursor: [250, 420],
  async setup(ctx) {
    await ctx.page.waitForSelector(CARD);
    await hideChecklist(ctx.page);
    if (setup) await setup(ctx);
  },
  run,
});
const vchat = (items) => chat(items, { vertical: true, width: 1000, title: "Your AI assistant", kicker: "Illustrative · real JobFlow output" });

export default {
  "reel-ranked": {
    output: "jobflow-reel-ranked",
    ...base,
    scenes: { hook: { pre: 0.25 }, filters: { post: 1.2 }, end: { post: 2.2 } },
    visuals: {
      hook: vcard({ ink: true, title: "Stop scrolling\n*500* job posts.", step: 0.1 }),
      rank: liveFeed(async ({ page, hand }) => {
        await hand.to(`${CARD} >> nth=0`, { at: [0.15, 0.1], ms: 500 }).catch(() => undefined);
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 1400, 3600);
      }, async ({ page }) => scrollToEl(page, `${CARD} >> nth=0`, { offset: 70, ms: 10 })),
      card: liveFeed(async ({ page, hand }) => {
        const c = page.locator(CARD).filter({ hasText: "new to you" }).first();
        await spotlight(page, c.locator("text=new to you").first(), 3000);
        await hand.to(c.locator("text=new to you").first(), { ms: 500 }).catch(() => undefined);
      }, async ({ page }) => scrollToEl(page, page.locator(CARD).filter({ hasText: "new to you" }).first(), { offset: 90, ms: 10 })),
      pay: liveFeed(async ({ page, hand }) => {
        const stated = page.locator(CARD).first().locator("text=/₹|\\$|€/").first();
        await spotlight(page, stated, 2200);
        await hand.to(stated, { ms: 500 }).catch(() => undefined);
        await sleep(2300);
        const est = page.locator(".badge--estimate").first();
        await scrollToEl(page, est, { offset: 220, ms: 800 });
        await spotlight(page, est, 2400);
        await hand.to(est, { ms: 400 }).catch(() => undefined);
      }, async ({ page }) => scrollToEl(page, `${CARD} >> nth=0`, { offset: 70, ms: 10 })),
      filters: liveFeed(async ({ page, hand }) => {
        // a chip in view in the sheet: remote only
        const chip = page.locator('.filter-rail[data-open="true"] .chip', { hasText: /^remote$/ }).first();
        await hand.click(chip, { ms: 400 });
        await sleep(250);
        await hand.click(page.getByRole("button", { name: /show results/i }).first(), { ms: 400 }).catch(() => undefined);
        await page.waitForSelector(".ux-hidden-report", { timeout: 3000 }).catch(() => undefined);
        const rep = page.locator(".ux-hidden-report").first();
        await scrollToEl(page, rep, { offset: 200, ms: 400 });
        await spotlight(page, rep, 2000);
      }, async ({ page }) => {
        // the sheet is already open when the cut lands
        await page.click(".filter-bar button");
        await page.waitForSelector('.filter-rail[data-open="true"]', { timeout: 4000 }).catch(() => undefined);
      }),
      end: vend(),
    },
  },
  "reel-gate": {
    output: "jobflow-reel-gate",
    ...base,
    scenes: { hook: { pre: 0.25 }, end: { post: 2.2 } },
    visuals: {
      hook: vcard({ ink: true, title: "It fills the form.\n*You* press submit.", step: 0.1 }),
      check: {
        kind: "live",
        view: MOBILE,
        chapter: false,
        cursor: [250, 420],
        async setup({ page }) {
          const id = await idOf(page, "Backend Engineer (Kafka)");
          await load(page, `/jobs/${id}#apply`);
          await scrollToEl(page, "#apply", { offset: 70, ms: 10 });
        },
        async run({ page, hand }) {
          const list = page.locator("#apply ul, #apply ol").first();
          await spotlight(page, list, 4000);
          await hand.to(list, { at: [0.3, 0.3], ms: 600 }).catch(() => undefined);
          await sleep(1500);
          await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 260, 1200);
        },
      },
      fill: fillForm({ view: MOBILE, vertical: true, paceMs: 420, endNote: false }),
      gate: {
        ...fillForm({ view: MOBILE, vertical: true, prefilled: true, hoverSubmitLine: 0 }),
      },
      you: vcard({ title: "You read it.\nYou press *submit*.", step: 0.12 }),
      end: vend(),
    },
  },
  "reel-mcp": {
    output: "jobflow-reel-mcp",
    ...base,
    scenes: { hook: { pre: 0.25 }, end: { post: 2.2 } },
    visuals: {
      hook: vcard({ ink: true, title: "Your AI assistant\n+ your *job search*.", step: 0.1 }),
      add: vcard({ kicker: "Claude Code · one command", title: "Add *JobFlow*.", sub: '<code style="font-size:.78em;line-height:1.5;display:block;background:#efe7d8;border-radius:14px;padding:.7em .8em">claude mcp add --transport stdio jobflow -- node ~/jobflow/apps/cli/bin/jobflow.mjs mcp</code>', step: 0.1 }),
      ask: vchat(() => [{ ...conversation().ask, t: 0.3 }]),
      results: vchat(() => {
        const c = conversation();
        return [{ ...c.ask, t: -2 }, { ...c.search, t: 0.1, run: 0.6, maxLines: 13 }];
      }),
      plan: vchat(() => {
        const c = conversation();
        return [{ ...c.ask, t: -4 }, { ...c.search, t: -4, maxLines: 13 }, { ...c.ask2, t: 0.1 }, { ...c.prep, t: 0.7, run: 0.6, maxLines: 18 }];
      }),
      end: vend(),
    },
  },
};
