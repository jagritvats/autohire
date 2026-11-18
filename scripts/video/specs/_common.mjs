// Shared building blocks for the video specs: title cards, terminal and chat scenes, and
// helpers that drive the real web app (demo mode) like a person would.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scrollToEl, smoothScroll } from "../lib/live.mjs";
import { termScript } from "../lib/term.mjs";
import { OUT, ROOT, VIDEO_DIR, WORK, ensureDir, sleep } from "../lib/util.mjs";

export const REPO_URL = "github.com/jagritvats/jobflow";

/**
 * The logo lockup from brand/logo (the horizontal lockup: tile + wordmark, one stop) — the
 * plain file for paper grounds, `-dark` for ink grounds (brand/README.md). Without brand/,
 * cards fall back to the wordmark set in type.
 */
export function logoUrl({ dark = false, kind = "horizontal" } = {}) {
  const file = join(ROOT, "brand", "logo", `jobflow-${kind}${dark ? "-dark" : ""}.svg`);
  return existsSync(file) ? pathToFileURL(file).href : null;
}

// ── deterministic pages ──

export function card(data) {
  return { kind: "page", page: "card.html", data: ({ dur }) => ({ duration: dur, logo: logoUrl({ dark: !!data.ink }), ...data }) };
}

export function endCard(extra = {}) {
  return card({
    variant: "end",
    sub: `Open source · local-first<br><span class="url">${REPO_URL}</span>`,
    pills: ["AGPL-3.0", "runs on your machine", "never submits for you"],
    noOut: true,
    ...extra,
  });
}

/** a terminal scene: `steps(lineAt)` → termScript steps */
export function term(steps, opts = {}) {
  return {
    kind: "page",
    page: "terminal.html",
    data: ({ lineAt }) => {
      const s = termScript(steps(lineAt));
      return { cols: 104, rows: 33, fontSize: 18, width: 1260, badge: "demo mode · fictional data", ...opts, writes: s.writes, heads: s.heads };
    },
  };
}

export function mcpOut(step) {
  return JSON.parse(readFileSync(join(OUT, "mcp", `${step}.json`), "utf8"));
}

/** the illustrative MCP conversation, built from real tool output */
export function conversation() {
  const search = mcpOut("search");
  const job = mcpOut("job");
  const prep = mcpOut("prepare");
  const id = job.args.id;
  // the assistant's words below restate THESE results; if the capture changed, rewrite them
  if (!/Pied Piper/.test(job.text) || !/new to you: AWS/.test(job.text) || !/The query hid 5/.test(search.text)) {
    throw new Error("the captured MCP output no longer matches the conversation's wording — update conversation() in specs/_common.mjs");
  }
  return {
    ask: { kind: "user", text: "Find remote backend roles I'd actually get, and explain the gaps." },
    search: { kind: "tool", tool: "search_jobs", args: search.args, result: search.text, maxLines: 18, hl: ["The query hid 5 (remote 5)", "Remote · Canada only"] },
    searchSay: {
      kind: "assistant",
      text: "Three remote roles came back, scored against your profile, and the query hid 5 that aren't remote. **Backend Engineer, Ledger** at Acme Pay (94) is already in your tracker. Next best: **Compression APIs** at Pied Piper (89). **Northwind Health** (62) is remote *within Canada only*, so it likely needs you to live there.",
    },
    get: { kind: "tool", tool: "get_job", args: { id: id.slice(0, 8) }, result: job.text, maxLines: 12, hl: ["new to you: AWS", "asks 2+ yrs"] },
    getSay: {
      kind: "assistant",
      text: "Pied Piper asks for 2+ years, and you have 3. The main language is TypeScript, which you have, plus Postgres and Redis. The gap is AWS, which would be new to you. Pay isn't stated. It isn't ready to pre-fill yet: there's no résumé file to attach.",
    },
    ask2: { kind: "user", text: "Is it ready to apply?" },
    prep: { kind: "tool", tool: "prepare_application", args: { id: id.slice(0, 8) }, result: prep.text, maxLines: 16, hl: ["Nothing was opened, filled or sent. JobFlow never submits."] },
    prepSay: {
      kind: "assistant",
      text: `Almost. This was a dry run: nothing was opened, filled or sent. Add your résumé with \`jobflow profile import ./resume.pdf\`, then run \`jobflow apply ${id.slice(0, 8)} --fill\` yourself. It fills the form in your browser and stops at the review screen; you check it and press submit.`,
    },
  };
}

/** a chat scene; items get absolute times (seconds into THIS scene; negative = already shown) */
export function chat(items, opts = {}) {
  return {
    kind: "page",
    page: "chat.html",
    data: ({ lineAt }) => ({ width: 1300, title: "<code>jobflow mcp</code> in an AI assistant", kicker: "Illustrative conversation", ...opts, items: items(lineAt) }),
  };
}

// ── the live web app ──

export const CARD = "article.match";

export async function load(page, path) {
  await page.goto(`${process.env.VIDEO_BASE ?? "http://localhost:" + (process.env.VIDEO_PORT || 3407)}${path}`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
}

export async function hideChecklist(page) {
  const later = page.locator("#get-started button", { hasText: "later" });
  if (await later.count()) await later.first().click().catch(() => undefined);
  await sleep(300);
}

/** the href of a job card by (part of) its title */
export async function jobHref(page, title) {
  return page.locator(`${CARD}`).filter({ hasText: title }).first().locator('a[href^="/jobs/"]').first().getAttribute("href");
}

export async function idOf(page, title) {
  await load(page, "/");
  await page.waitForSelector(CARD);
  const href = await jobHref(page, title);
  return href?.split("/").pop()?.split("#")[0];
}

export { scrollToEl, smoothScroll, sleep };

/** a gentle highlight around an element (a video annotation, not app UI) */
export async function spotlight(page, target, ms = 2200) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.evaluate((el, ms) => {
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;z-index:2147483600;pointer-events:none;left:${r.left - 8}px;top:${r.top - 6}px;width:${r.width + 16}px;height:${r.height + 12}px;border:2.5px solid #b8401c;border-radius:10px;box-shadow:0 0 0 6px rgba(184,64,28,.12);animation:__spot ${ms}ms ease both`;
    const st = document.createElement("style");
    st.textContent = "@keyframes __spot{0%{opacity:0;transform:scale(1.04)}12%{opacity:1;transform:none}85%{opacity:1}100%{opacity:0}}";
    document.documentElement.append(st, d);
    setTimeout(() => d.remove(), ms + 50);
  }, ms).catch(() => undefined);
}

/** a caption-style note pinned on the footage (a video annotation, clearly not app UI) */
export async function note(page, html, { top = 26, ms = 4000, vertical = false } = {}) {
  await page.evaluate(
    ([html, top, ms, vertical]) => {
      const d = document.createElement("div");
      d.innerHTML = html;
      d.style.cssText = `position:fixed;z-index:2147483641;left:50%;top:${top}px;transform:translateX(-50%);padding:.7em 1.2em;border-radius:999px;background:#1c1915;color:#f6f1e7;font:600 ${vertical ? 16 : 20}px "Schibsted Grotesk",system-ui,sans-serif;box-shadow:0 14px 34px -14px rgba(0,0,0,.55);pointer-events:none;white-space:nowrap;animation:__nin .45s cubic-bezier(.2,.8,.2,1) both${ms ? `, __nout .4s ease-in ${ms}ms both` : ""}`;
      const st = document.createElement("style");
      st.textContent = "@keyframes __nin{from{opacity:0;transform:translate(-50%,-12px)}to{opacity:1;transform:translate(-50%,0)}}@keyframes __nout{to{opacity:0}}";
      document.documentElement.append(st, d);
    },
    [html, top, ms, vertical],
  );
}

/**
 * The REAL form-filler (`fillPlanOnPage` from @jobflow/autofill — the code `jobflow apply
 * --fill` runs) on a fictional employer's form, paced so each field can be seen. It fills
 * and stops: there is no submit code path to call.
 */
export function fillForm({ startLine = 0, view = {}, endNote = true, hoverSubmitLine = null, vertical = false, paceMs = 650, prefilled = false } = {}) {
  return {
    kind: "live",
    noServer: true,
    view,
    chapter: false,
    async setup({ page }) {
      await page.goto(pathToFileURL(join(VIDEO_DIR, "pages", "apply-form.html")).href, { waitUntil: "load" });
      if (prefilled) await runFiller(page, 0);
    },
    cursor: vertical ? [300, 560] : [1300, 700],
    async run({ page, hand, at }) {
      if (!prefilled) {
        await at(startLine, 0.2);
        await runFiller(page, paceMs);
      }
      if (endNote) await note(page, '<span style="color:#e0673f">●</span>&nbsp; Stopped at the review screen. Nothing was submitted.', { top: vertical ? 92 : 22, ms: 0, vertical });
      if (hoverSubmitLine != null) {
        await at(hoverSubmitLine, 0.4);
        await scrollToEl(page, "#submit_app", { offset: vertical ? 300 : 520, ms: 900 });
        await hand.to("#submit_app", { ms: 900 });
      }
      if ((await page.title()) === "SUBMITTED") throw new Error("form was submitted — never");
    },
  };
}

async function runFiller(page, paceMs) {
  const af = await import(pathToFileURL(join(ROOT, "packages", "autofill", "src", "index.ts")).href);
  const resume = join(ensureDir(join(WORK, "fixtures")), "Alex_Example_Resume.pdf");
  if (!existsSync(resume)) writeFileSync(resume, "%PDF-1.4\n% fictional résumé (Alex Example)\n");
  const plan = af.buildFillPlan("greenhouse", page.url(), {
    firstName: "Alex",
    lastName: "Example",
    email: "alex@example.com",
    phone: "+91 98765 00000",
    linkedin: "linkedin.com/in/alex-example",
    resumePath: resume,
    answers: {},
  });
  const flags = { browser: "on", mode: "fill", autosubmit: false, rate: "fast", tier3Sources: [] };
  af.assertNeverSubmits(flags);
  // pace each field so a viewer can follow; the filling itself is the library's
  const report = await af.fillPlanOnPage(pacePage(page, paceMs), plan, { flags });
  if (report.submitted) throw new Error("the form-filler reported a submission — impossible by design");
  return report;
}

function pacePage(page, ms) {
  const wrapLoc = (loc) =>
    new Proxy(loc, {
      get(t, k) {
        if (k === "fill" || k === "setInputFiles")
          return async (...a) => {
            if (ms) await sleep(ms);
            await t.scrollIntoViewIfNeeded().catch(() => undefined);
            return t[k](...a);
          };
        if (k === "first") return () => wrapLoc(t.first());
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(page, {
    get(t, k) {
      if (k === "locator") return (...a) => wrapLoc(t.locator(...a));
      if (k === "goto") return async () => undefined; // already on the form (opened before the clip)
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
