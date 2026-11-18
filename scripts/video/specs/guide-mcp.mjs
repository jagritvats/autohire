// "Use JobFlow from Claude Code (MCP)": the real `claude mcp add` / `claude mcp list`
// sessions, then an ILLUSTRATIVE conversation (neutral layout) built from real tool output.
import { card, chat, conversation, endCard, fillForm, note, term } from "./_common.mjs";

export default {
  output: "jobflow-guide-mcp",
  posterAt: 2.4,
  defaults: { pre: 0.5, gap: 0.5, post: 0.8 },
  scenes: {
    title: { pre: 0.9 },
    safety: { post: 3.2 },
  },
  visuals: {
    title: card({ kicker: "Guide · MCP", title: "Use JobFlow from\n*Claude Code*.", sub: "<code>jobflow mcp</code> serves your local job data to an AI assistant: search, read a job, plan an application. It never fills or submits a form." }),
    add: term((l) => [
      { type: "head", title: "Add the server", kicker: "One command" },
      { type: "type", cmd: "claude mcp add --transport stdio jobflow -- node ~/jobflow/apps/cli/bin/jobflow.mjs mcp", at: 0.5, cps: 20 },
      { type: "play", rec: "mcp-add", maxGap: 0.3 },
      { type: "type", cmd: "claude mcp list", at: l(1, -0.2), cps: 18 },
      { type: "play", rec: "mcp-list", maxGap: 0.6 },
    ], { badge: null, barTitle: "~/jobflow" }),
    search: chat((l) => {
      const c = conversation();
      return [
        { ...c.ask, t: 0.5 },
        { ...c.search, t: l(0, 2.6), run: 1.1 },
        { ...c.searchSay, t: l(1, -0.4), wps: 8 },
      ];
    }),
    getjob: chat((l) => {
      const c = conversation();
      return [
        { ...c.ask, t: -3 },
        { ...c.search, t: -3 },
        { ...c.searchSay, t: -3 },
        { ...c.get, t: 0.5, run: 0.9 },
        { ...c.getSay, t: l(0, 4.2), wps: 8 },
      ];
    }),
    prepare: chat(() => {
      const c = conversation();
      return [
        { ...c.ask, t: -6 },
        { ...c.search, t: -6 },
        { ...c.searchSay, t: -6 },
        { ...c.get, t: -6 },
        { ...c.getSay, t: -6 },
        { ...c.ask2, t: 0.3 },
        { ...c.prep, t: 1.1, run: 0.9 },
        { ...c.prepSay, t: 6.2, wps: 9 },
      ];
    }),
    fill: {
      ...fillForm({ startLine: 0, hoverSubmitLine: 1 }),
      async setup(ctx) {
        await fillForm().setup(ctx);
        await note(ctx.page, '<code style="font-family:JetBrains Mono,monospace">jobflow apply b24c1d64 --fill</code> &nbsp;·&nbsp; the real form-filler, on a fictional form', { top: 22, ms: 3600 });
      },
    },
    safety: {
      kind: "seq",
      parts: [
        { until: (l) => l(0) + 6.5, visual: card({ kicker: "What stays true", title: "Local data. Public boards.\n*You* press submit.", pills: ["your local data", "public job boards only", "no form filling over MCP", "docs/guides/ai-agents-mcp.md"] }) },
        { visual: endCard() },
      ],
    },
  },
};
