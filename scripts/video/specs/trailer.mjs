// The ~50 s trailer: quick cuts of the real UI between kinetic Editorial title cards.
// Honest claims only — it never implies auto-applying or server-side scraping of logged-in sites.
import { CARD, card, chat, conversation, endCard, fillForm, hideChecklist, idOf, load, scrollToEl, sleep, smoothScroll, spotlight, term } from "./_common.mjs";

export default {
  output: "jobflow-trailer",
  posterAt: 1.6,
  captionedVariant: true,
  whooshes: ["boards", "cards", "gate", "anywhere", "local", "end"],
  musicVolume: 0.22,
  defaults: { pre: 0.35, gap: 0.3, post: 0.45 },
  scenes: {
    hook: { pre: 0.5, post: 0.9 },
    end: { post: 3.4 },
  },
  visuals: {
    hook: card({ ink: true, title: "Job boards rank by ads.\nJobFlow ranks by *you*.", step: 0.13 }),
    boards: {
      kind: "live",
      url: "/",
      chapter: false,
      async setup({ page }) {
        await page.waitForSelector(CARD);
        await hideChecklist(page);
        await scrollToEl(page, `${CARD} >> nth=0`, { offset: 150, ms: 10 });
      },
      async run({ page, hand }) {
        await hand.to(`${CARD} >> nth=0`, { at: [0.04, 0.2], ms: 700 });
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 1300, 4200);
      },
    },
    cards: {
      kind: "live",
      url: "/",
      chapter: false,
      async setup({ page }) {
        await page.waitForSelector(CARD);
        await hideChecklist(page);
        const c = page.locator(CARD).filter({ hasText: "staffing agency" }).first();
        await scrollToEl(page, c, { offset: 220, ms: 10 });
      },
      async run({ page, hand }) {
        const c = page.locator(CARD).filter({ hasText: "staffing agency" }).first();
        await hand.to(c.locator("text=STACK").first(), { at: [4, 0.5], ms: 600 }).catch(() => undefined);
        await spotlight(page, c.locator("text=STACK").first().locator(".."), 1700);
        await sleep(1700);
        await spotlight(page, c.locator(".badge--estimate").first(), 1600);
        await hand.to(c.locator(".badge--estimate").first(), { ms: 500 }).catch(() => undefined);
        await sleep(1600);
        await spotlight(page, c.locator(".match__flag").first(), 1600);
        await hand.to(c.locator(".match__flag").first(), { at: [0.15, 0.5], ms: 500 }).catch(() => undefined);
      },
    },
    filters: {
      kind: "live",
      url: "/",
      chapter: false,
      async setup({ page }) {
        await page.waitForSelector(CARD);
        await hideChecklist(page);
        await smoothScroll(page, 180, 10);
      },
      async run({ page, hand }) {
        await hand.click(page.locator(".filter-rail .chip", { hasText: "staffing agencies" }).first(), { ms: 700 });
        await page.waitForSelector(".ux-hidden-report", { timeout: 5000 }).catch(() => undefined);
        const rep = page.locator(".ux-hidden-report").first();
        await scrollToEl(page, rep, { offset: 320, ms: 600 }).catch(() => undefined);
        await spotlight(page, rep, 2400);
        await hand.to(rep, { at: [0.3, 0.5], ms: 600 }).catch(() => undefined);
      },
    },
    tailor: {
      kind: "live",
      chapter: false,
      async setup({ page }) {
        const id = await idOf(page, "Backend Engineer (Kafka)");
        await load(page, `/tailor/${id}`);
        await scrollToEl(page, "text=grounded on", { offset: 260, ms: 10 }).catch(() => undefined);
      },
      async run({ page, hand }) {
        await spotlight(page, page.locator("text=grounded on").first().locator(".."), 2000);
        await hand.to("text=grounded on", { ms: 600 }).catch(() => undefined);
        await sleep(1300);
        await hand.click(page.getByRole("button", { name: /^generate$/i }).first(), { ms: 700 });
        await sleep(900);
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 300, 1100);
      },
    },
    gate: fillForm({ startLine: 0, hoverSubmitLine: 0 }),
    anywhere: {
      kind: "seq",
      parts: [
        // already run when the cut lands (negative times show on the first frame)
        { until: 1.6, visual: term(() => [{ type: "head", title: "<code>jobflow feed</code>", kicker: "Terminal" }, { type: "type", cmd: "pnpm jobflow feed --limit 6", at: -3, cps: 40, hold: 0.1 }, { type: "play", rec: "feed", maxGap: 0.05 }]) },
        {
          until: 3.2,
          visual: chat(() => {
            const c = conversation();
            return [{ ...c.ask, t: -1 }, { ...c.search, t: -0.5 }, { ...c.searchSay, t: 0.1, wps: 18 }];
          }, { kicker: "AI assistant · MCP" }),
        },
        {
          visual: {
            kind: "live",
            url: "/",
            chapter: false,
            async setup({ page }) {
              await page.waitForSelector(CARD);
            },
            async run({ page, hand }) {
              await hand.to(".sync-ind", { ms: 600 }).catch(() => undefined);
            },
          },
        },
      ],
    },
    local: card({ title: "Runs on *your* machine.", sub: "Your data stays in <code>~/.jobflow</code>. Logged-in sites are never read by a server.", step: 0.12 }),
    end: endCard(),
  },
};
