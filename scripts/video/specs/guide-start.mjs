// "Get started in 5 minutes" — terminal-first, from real captured sessions.
import { CARD, card, endCard, hideChecklist, sleep, smoothScroll, term } from "./_common.mjs";

export default {
  output: "jobflow-guide-get-started",
  posterAt: 2.2,
  defaults: { pre: 0.5, gap: 0.5, post: 0.8 },
  scenes: {
    title: { pre: 0.9, post: 1.0 },
    sync: { min: 21 },
    next: { post: 3.0 },
  },
  visuals: {
    title: card({ kicker: "Guide", title: "Get started\nin *5 minutes*.", sub: "Clone → install → <code>jobflow init</code> → <code>sync</code> → <code>feed</code> → <code>show</code> → <code>serve</code>" }),
    install: term((l) => [
      { type: "head", title: "Clone, install, build", kicker: "Node 20+ and pnpm" },
      { type: "type", cmd: "git clone https://github.com/jagritvats/jobflow.git && cd jobflow", at: 0.4, cps: 26 },
      { type: "note", text: "⋯" },
      { type: "type", cmd: "pnpm install", at: l(1, 0.2), cps: 20 },
      { type: "play", rec: "install", maxGap: 0.25 },
      { type: "type", cmd: "pnpm -r build", cps: 20 },
      { type: "play", rec: "build", maxGap: 0.03 },
    ]),
    init: term((l) => [
      { type: "head", title: "<code>jobflow init</code>", kicker: "Your profile" },
      { type: "type", cmd: "pnpm jobflow init --sample", at: 0.6, cps: 18 },
      { type: "play", rec: "init-sample", maxGap: 0.4 },
    ]),
    sync: term(() => [
      { type: "head", title: "<code>jobflow sync</code>", kicker: "Live progress" },
      { type: "type", cmd: "pnpm jobflow sync", at: 0.5, cps: 18 },
      { type: "play", rec: "sync", maxGap: 0.5 },
    ]),
    feed: term(() => [
      { type: "head", title: "<code>jobflow feed</code>", kicker: "Your ranked list" },
      { type: "type", cmd: "pnpm jobflow feed --limit 6", at: 0.4, cps: 20 },
      { type: "play", rec: "feed", maxGap: 0.3 },
    ]),
    show: term(() => [
      { type: "head", title: "<code>jobflow show</code>", kicker: "One job in full" },
      { type: "type", cmd: "pnpm jobflow show 5", at: 0.4, cps: 18 },
      { type: "play", rec: "show", maxGap: 0.3 },
    ]),
    serve: {
      kind: "seq",
      parts: [
        {
          until: 4.2,
          visual: term(() => [
            { type: "head", title: "<code>jobflow serve</code>", kicker: "The web app, on localhost" },
            { type: "type", cmd: "pnpm jobflow serve", at: 0.3, cps: 18 },
            { type: "play", rec: "serve", maxGap: 0.4, thenPrompt: false },
          ]),
        },
        {
          visual: {
            kind: "live",
            url: "/",
            chapter: false,
            async setup({ page }) {
              await page.waitForSelector(CARD);
              await hideChecklist(page);
            },
            async run({ page, hand }) {
              await sleep(300);
              await smoothScroll(page, 520, 2000);
              await hand.to(`${CARD} >> nth=0`, { at: [0.05, 0.3], ms: 800 }).catch(() => undefined);
            },
          },
        },
      ],
    },
    next: {
      kind: "seq",
      parts: [
        { until: (l) => l(0) + 5.2, visual: card({ kicker: "Next", title: "Search, tailor, apply.", pills: ["jobflow search", "jobflow tailor", "jobflow apply --fill", "docs/guides"] }) },
        { visual: endCard() },
      ],
    },
  },
};
