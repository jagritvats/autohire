// The ~3.5 minute narrated walkthrough. Narration: narration/walkthrough.json.
import { join } from "node:path";
import { CARD, card, chat, conversation, endCard, fillForm, hideChecklist, idOf, load, scrollToEl, sleep, smoothScroll, spotlight, term } from "./_common.mjs";
import { OUT } from "../lib/util.mjs";

const jobPage = (title) => async ({ page }) => {
  const id = await idOf(page, title);
  await load(page, `/jobs/${id}`);
};

export default {
  output: "jobflow-walkthrough",
  chapters: true,
  posterAt: 2.6,
  defaults: { pre: 0.5, gap: 0.45, post: 0.7 },
  scenes: {
    intro: { pre: 0.9 },
    sync: { post: 1.2 },
    outro: { post: 4.2 },
  },
  visuals: {
    intro: {
      kind: "seq",
      parts: [
        { until: (l) => l(1) - 0.15, visual: card({ kicker: "A walkthrough", title: "Your job search,\non *your* machine.", sub: "Find roles · honest matches · grounded drafts · a form-filler that stops for you" }) },
        {
          visual: {
            kind: "live",
            url: "/",
            chapter: false,
            async setup({ page }) {
              await page.waitForSelector(CARD);
              await hideChecklist(page);
            },
            async run({ page, hand, at }) {
              await sleep(400);
              await scrollToEl(page, "text=All jobs", { offset: 150, ms: 1600 });
              await hand.to(`${CARD} >> nth=0`, { at: [0.06, 0.25], ms: 900 });
              await at(1, 0.2);
              await smoothScroll(page, 1500, 3800);
              await hand.to(`${CARD} >> nth=3`, { at: [0.3, 0.3], ms: 900 }).catch(() => undefined);
            },
          },
        },
      ],
    },
    setup: term((l) => [
      { type: "head", title: "Set up", kicker: "Clone · install · build · init" },
      { type: "type", cmd: "git clone https://github.com/jagritvats/jobflow.git && cd jobflow", at: 0.2, cps: 36, hold: 0.25 },
      { type: "note", text: "⋯" },
      { type: "type", cmd: "pnpm install && pnpm -r build", cps: 30, hold: 0.25 },
      { type: "play", rec: "install", maxGap: 0.05, thenPrompt: false },
      { type: "play", rec: "build", maxGap: 0.012, tail: 0.1 },
      { type: "clear", at: l(1, 0.9) },
      { type: "type", cmd: "pnpm jobflow init --yes --resume ~/sam-placeholder-cv.pdf", cps: 30, wait: 0.05 },
      { type: "play", rec: "init-resume", maxGap: 0.35 },
    ]),
    onboarding: {
      kind: "live",
      url: "/onboarding",
      async run({ page, hand, at }) {
        await sleep(300);
        const chooser = page.waitForEvent("filechooser");
        await hand.click('input[type="file"]', { at: [0.2, 0.5], ms: 1000 });
        const fc = await chooser;
        await sleep(500);
        await fc.setFiles(join(OUT, "cli-home", "sam-placeholder-cv.pdf"));
        await page.waitForSelector("text=Contact", { timeout: 15_000 });
        await sleep(500);
        await at(1, -0.3);
        await scrollToEl(page, "text=Skills", { offset: 140, ms: 1300 }).catch(() => undefined);
        await hand.to("text=Skills", { at: [0.5, 0.5], ms: 700 }).catch(() => undefined);
        await sleep(1700);
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 520, 1500);
        await at(2, -0.2);
        await hand.click(page.getByRole("button", { name: /Looks right/ }), { ms: 900 });
        await sleep(400);
        await smoothScroll(page, 0, 600);
        await sleep(900);
        await scrollToEl(page, "text=Where you work", { offset: 120, ms: 1200 }).catch(() => undefined);
        await sleep(1200);
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 380, 1400);
      },
    },
    sync: {
      kind: "live",
      url: "/",
      async setup({ page }) {
        await page.waitForSelector(CARD);
      },
      async run({ page, hand, at }) {
        await sleep(500);
        await hand.click(".sync-ind", { ms: 900 });
        await page.waitForSelector("#sync-panel");
        await sleep(700);
        await hand.click(page.locator("#sync-panel button", { hasText: /sync now/i }).first(), { ms: 800 });
        await at(1, 0.2);
        await hand.to("#sync-panel .sync-steps", { at: [0.4, 0.2], ms: 900 }).catch(() => undefined);
        await sleep(1800);
        await hand.to("#sync-panel .sync-inflight, #sync-panel .sync-counts", { at: [0.3, 0.5], ms: 900 }).catch(() => undefined);
        await at(2, 0.1);
        const errs = page.locator("#sync-panel .sync-errors");
        if (await errs.count()) {
          await errs.first().scrollIntoViewIfNeeded().catch(() => undefined);
          await spotlight(page, errs.first(), 3200);
          await hand.to(errs.first(), { at: [0.3, 0.3], ms: 800 }).catch(() => undefined);
        }
      },
    },
    feed: {
      kind: "live",
      url: "/",
      async setup({ page }) {
        await page.waitForSelector(CARD);
        await hideChecklist(page);
        await scrollToEl(page, `${CARD} >> nth=0`, { offset: 120, ms: 10 });
      },
      async run({ page, hand, at }) {
        await sleep(300);
        await hand.to(`${CARD} >> nth=0`, { at: [0.05, 0.2], ms: 900 });
        await spotlight(page, `${CARD} >> nth=0`, 2000);
        await at(1, 0.3);
        await hand.to(`${CARD} >> nth=0 >> text=STACK`, { at: [3, 0.5], ms: 900 }).catch(() => undefined);
        await sleep(1600);
        // a card whose stack note names a gap
        const gap = page.locator(CARD).filter({ hasText: "new to you" }).first();
        await scrollToEl(page, gap, { offset: 140, ms: 1400 });
        await spotlight(page, gap.locator("text=new to you").first(), 2600);
        await hand.to(gap.locator("text=new to you").first(), { ms: 800 }).catch(() => undefined);
        await at(2, 0.1);
        // an estimate on a card further down (no scrolling back up)
        const below = page.locator(CARD).filter({ hasText: "Checkout" }).locator(".badge--estimate");
        const est = (await below.count()) ? below.first() : page.locator(".badge--estimate").first();
        await scrollToEl(page, est, { offset: 300, ms: 1200 });
        await hand.to(est, { ms: 700 });
        await spotlight(page, est, 2600);
        await at(3, 0.2);
        const agency = page.locator(CARD).filter({ hasText: "staffing agency" }).first();
        await scrollToEl(page, agency, { offset: 160, ms: 1200 });
        await spotlight(page, agency.locator(".match__flag").first(), 2400);
        await hand.to(agency.locator(".match__flag").first(), { at: [0.2, 0.5], ms: 700 });
        await sleep(2500);
        const canada = page.locator(CARD).filter({ hasText: "Canada" }).first();
        await scrollToEl(page, canada, { offset: 160, ms: 1300 });
        await spotlight(page, canada.locator(".match__flag").first(), 2400);
        await hand.to(canada.locator(".match__flag").first(), { at: [0.2, 0.5], ms: 700 }).catch(() => undefined);
      },
    },
    filters: {
      kind: "seq",
      parts: [
        {
          until: (l) => l(1) - 0.1,
          visual: {
            kind: "live",
            url: "/",
            async setup({ page }) {
              await page.waitForSelector(CARD);
              await hideChecklist(page);
            },
            async run({ page, hand }) {
              await sleep(300);
              const chip = page.locator(".filter-rail .chip", { hasText: "staffing agencies" }).first();
              await hand.click(chip, { ms: 1000 });
              await page.waitForSelector(".ux-hidden-report", { timeout: 5000 }).catch(() => undefined);
              await sleep(500);
              const rep = page.locator(".ux-hidden-report").first();
              await scrollToEl(page, rep, { offset: 300, ms: 900 });
              await spotlight(page, rep, 3400);
              await hand.to(rep, { at: [0.3, 0.5], ms: 900 }).catch(() => undefined);
            },
          },
        },
        {
          // the only two hard exclusions: a stated salary below your floor, and a place you can't work from
          visual: {
            kind: "live",
            url: "/profile",
            chapter: false,
            async setup({ page }) {
              await scrollToEl(page, page.locator("h2", { hasText: "What you want" }).first(), { offset: 100, ms: 10 });
            },
            async run({ page, hand }) {
              await sleep(300);
              // the page says it in so many words
              const hint = page.locator("h2", { hasText: "What you want" }).first().locator("xpath=following-sibling::p[1]");
              await spotlight(page, hint, 2600);
              await hand.to(hint, { at: [0.6, 0.6], ms: 800 }).catch(() => undefined);
              await sleep(2000);
              const floor = page.locator("label", { hasText: /floor/i }).first();
              await spotlight(page, floor, 2000);
              await hand.to(floor, { ms: 600 }).catch(() => undefined);
              await sleep(1600);
              const remote = page.locator("text=/remote regions|Remote roles/i").first();
              await spotlight(page, remote.locator(".."), 2600);
              await hand.to(remote, { ms: 800 }).catch(() => undefined);
            },
          },
        },
      ],
    },
    job: {
      kind: "live",
      setup: jobPage("Backend Engineer (Kafka)"),
      async run({ page, hand }) {
        await sleep(300);
        await hand.to("h1", { at: [0.2, 0.6], ms: 800 }).catch(() => undefined);
        await sleep(600);
        await scrollToEl(page, "text=How you fit", { offset: 110, ms: 1400 }).catch(() => smoothScroll(page, 400, 1400));
        await sleep(1500);
        await scrollToEl(page, "text=Job description", { offset: 110, ms: 1600 }).catch(() => undefined);
      },
    },
    search: {
      kind: "live",
      url: "/search",
      async run({ page, hand, at }) {
        await sleep(300);
        await hand.click(page.locator("button, .chip", { hasText: "backend engineer --remote" }).first(), { ms: 900 });
        await sleep(400);
        const go = page.locator(".search-bar button", { hasText: /search/i }).first();
        await hand.click(go, { ms: 600 });
        await page.waitForSelector(CARD, { timeout: 15_000 }).catch(() => undefined);
        await sleep(600);
        await scrollToEl(page, `${CARD} >> nth=0`, { offset: 260, ms: 1200 }).catch(() => undefined);
        const rep = page.locator(".ux-hidden-report, text=/hid|hidden/i").first();
        await spotlight(page, rep, 2400);
        await at(1, -0.2);
        const keep = page.locator("text=Keep this search").first();
        await scrollToEl(page, keep, { offset: 220, ms: 1200 }).catch(() => undefined);
        const name = page.locator('input[placeholder="e.g. remote backend"]').first();
        await hand.click(name, { ms: 700 });
        await name.fill("");
        await hand.type("Remote backend", { cps: 18 });
        await hand.click(page.getByRole("button", { name: "Save search" }), { ms: 700 });
        await sleep(700);
        await hand.to(page.locator("text=Open it in Jobs").first(), { ms: 700 }).catch(() => undefined);
      },
    },
    tailor: {
      kind: "live",
      async setup({ page }) {
        const id = await idOf(page, "Backend Engineer (Kafka)");
        await load(page, `/tailor/${id}`);
      },
      async run({ page, hand, at }) {
        await sleep(300);
        await hand.to("h1", { at: [0.3, 0.6], ms: 800 }).catch(() => undefined);
        await at(1, -0.3);
        const strip = page.locator("text=grounded on").first();
        await spotlight(page, strip.locator(".."), 3200);
        await hand.to(strip, { ms: 800 }).catch(() => undefined);
        await sleep(1800);
        await scrollToEl(page, "text=Tailored résumé", { offset: 120, ms: 1100 }).catch(() => undefined);
        await hand.click(page.getByRole("button", { name: /^generate$/i }).first(), { ms: 800 });
        await sleep(1800);
        await smoothScroll(page, (await page.evaluate(() => window.scrollY)) + 360, 1300);
        await at(2, 0.3);
        const cover = page.locator("h2", { hasText: "Cover letter" }).first();
        await scrollToEl(page, cover, { offset: 120, ms: 1300 });
        await spotlight(page, cover.locator(".."), 3000);
        await hand.to(cover, { ms: 800 }).catch(() => undefined);
      },
    },
    apply: {
      kind: "seq",
      parts: [
        {
          until: (l) => l(2) - 0.15,
          visual: {
            kind: "live",
            async setup({ page }) {
              const id = await idOf(page, "Backend Engineer (Kafka)");
              await load(page, `/jobs/${id}#apply`);
              await scrollToEl(page, "#apply", { offset: 90, ms: 10 });
            },
            async run({ page, hand, at }) {
              await sleep(300);
              await hand.to("#apply", { at: [0.2, 0.25], ms: 900 });
              await spotlight(page, page.locator("#apply ul, #apply ol").first(), 3000);
              await at(1, 0.1);
              const prefill = page.locator("text=2. Pre-fill it on this computer").first();
              await scrollToEl(page, prefill, { offset: 260, ms: 900 }).catch(() => undefined);
              await spotlight(page, prefill.locator("xpath=.."), 3500);
              await hand.to(prefill, { ms: 800 }).catch(() => undefined);
            },
          },
        },
        { visual: fillForm({ startLine: 0, hoverSubmitLine: 1 }) },
      ],
    },
    applications: {
      kind: "live",
      url: "/applications",
      async run({ page, hand }) {
        await sleep(300);
        await hand.to("text=In progress", { ms: 900 }).catch(() => undefined);
        await scrollToEl(page, "text=In progress", { offset: 140, ms: 1200 }).catch(() => undefined);
        await sleep(600);
        const row = page.locator(".crm-row").filter({ hasText: "Platform Engineer" }).first();
        await spotlight(page, row, 3000);
        await hand.to(row.locator("input").first(), { ms: 900 }).catch(() => undefined);
      },
    },
    mcp: chat((l) => {
      const c = conversation();
      return [
        { ...c.ask, t: 0.4 },
        { ...c.search, t: l(0, 3.2), run: 1.2 },
        { ...c.searchSay, t: l(1, -0.6), wps: 9 },
      ];
    }),
    outro: {
      kind: "seq",
      parts: [
        { until: (l) => l(1) - 0.1, visual: endCard({ noOut: false }) },
        {
          // Settings → Appearance: Editorial → Classic → Spark → back to Editorial, then the
          // one dark-theme moment
          until: (l) => l(1) + 6.6,
          visual: {
            kind: "live",
            url: "/settings#appearance",
            view: { colorScheme: "light" },
            chapter: false,
            async setup({ page }) {
              await scrollToEl(page, "#appearance", { offset: 90, ms: 10 });
            },
            async run({ page, hand }) {
              const style = (name) => page.locator(".style-option", { hasText: name }).first();
              await hand.click(style("Classic"), { ms: 500, pause: 100 });
              await sleep(800);
              await hand.click(style("Spark"), { ms: 500, pause: 100 });
              await sleep(800);
              await hand.click(style("Editorial"), { ms: 500, pause: 100 });
              await sleep(500);
              await hand.click(page.getByRole("radio", { name: /^dark$/i }).first().or(page.getByRole("button", { name: /^dark$/i }).first()), { ms: 600 }).catch(() => undefined);
              await sleep(1200);
            },
          },
        },
        { visual: endCard({ variant: "end" }) },
      ],
    },
  },
};
