// Live capture of the real web app: a CDP screencast (JPEG frames with timestamps — sharper
// than Playwright's built-in recorder) plus a visible cursor, human-paced pointer moves,
// smooth scrolling and typing. A scene's clip starts at `mark()` — loading before it is cut.
import { FrameSink } from "./frames.mjs";
import { sleep } from "./util.mjs";

/** a cursor dot + click ripple, injected into every page (the headless browser draws none) */
const CURSOR_JS = `
(() => {
  if (window.__vcursor) return;
  window.__vcursor = true;
  const css = \`
  #__vc{position:fixed;left:0;top:0;width:22px;height:22px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;
    transition:opacity .25s;opacity:0}
  #__vc svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
  .__vr{position:fixed;z-index:2147483646;pointer-events:none;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;
    border:2.5px solid rgba(184,64,28,.85);background:rgba(184,64,28,.12);animation:__vr .55s ease-out forwards}
  @keyframes __vr{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
  html{scroll-behavior:auto!important}
  \`;
  const add = () => {
    if (document.getElementById('__vc')) return;
    const s = document.createElement('style'); s.textContent = css; document.documentElement.appendChild(s);
    const c = document.createElement('div'); c.id = '__vc';
    c.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23.5 L13.5 22.2 L10 14.5 L17 14.5 Z" fill="#1c1915" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const p = window.__vpos; if (p) { c.style.transform = 'translate('+p[0]+'px,'+p[1]+'px)'; c.style.opacity = 1; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  addEventListener('mousemove', (e) => {
    add(); window.__vpos = [e.clientX, e.clientY];
    try { sessionStorage.setItem('__vpos', JSON.stringify(window.__vpos)); } catch {}
    const c = document.getElementById('__vc'); c.style.transform = 'translate('+e.clientX+'px,'+e.clientY+'px)'; c.style.opacity = 1;
  }, true);
  addEventListener('mousedown', (e) => {
    const r = document.createElement('div'); r.className = '__vr'; r.style.left = e.clientX+'px'; r.style.top = e.clientY+'px';
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  try { const p = JSON.parse(sessionStorage.getItem('__vpos') || 'null'); if (p) window.__vpos = p; } catch {}
})();
`;

export async function newScenePage(browser, { width, height, scale = 1, colorScheme = "light", mobile = false, storage } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme,
    timezoneId: "UTC",
    locale: "en-US",
    isMobile: mobile,
    hasTouch: mobile,
    ...(storage ? { storageState: storage } : {}),
  });
  await context.addInitScript(CURSOR_JS);
  const page = await context.newPage();
  return { context, page };
}

/**
 * Start a screencast. Returns { mark, stop } — `mark()` sets the clip's zero; `stop()` ends
 * capture and returns { sink, t0 } where frame times are seconds from the mark.
 */
export async function startScreencast(page, dir, { width, height, quality = 92 }) {
  const sink = new FrameSink(dir);
  const cdp = await page.context().newCDPSession(page);
  let zero = null;
  let last = null;
  const pending = [];
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    const ts = f.metadata.timestamp; // seconds, wall clock
    last = { data: f.data, ts };
    pending.push(last);
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    /** the clip starts now; the frame on screen at this moment is its first frame */
    mark() {
      zero = Date.now() / 1000;
    },
    async stop() {
      await sleep(150);
      await cdp.send("Page.stopScreencast").catch(() => {});
      if (zero == null) throw new Error("screencast stopped before mark()");
      for (const f of pending) sink.add(Buffer.from(f.data, "base64"), f.ts - zero);
      if (!pending.length) throw new Error("no screencast frames");
      return sink;
    },
  };
}

// ── human-paced interaction ──

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export class Hand {
  constructor(page) {
    this.page = page;
    this.x = 960;
    this.y = 600;
  }
  async place(x, y) {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
  }
  /** glide to (x, y) over `ms` */
  async glide(x, y, ms = 650) {
    const steps = Math.max(8, Math.round(ms / 16));
    const sx = this.x;
    const sy = this.y;
    // a slight arc reads as a hand, not a robot
    const bend = Math.min(60, Math.hypot(x - sx, y - sy) * 0.08);
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      const arc = Math.sin(Math.PI * k) * bend;
      await this.page.mouse.move(sx + (x - sx) * k, sy + (y - sy) * k - arc);
      await sleep(ms / steps);
    }
    this.x = x;
    this.y = y;
  }
  async box(target) {
    const loc = typeof target === "string" ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: "visible", timeout: 5000 }).catch((e) => {
      console.warn(`    ! hand: ${typeof target === "string" ? target : "(locator)"} not visible`);
      throw e;
    });
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no box for ${target}`);
    return b;
  }
  /** move onto an element (its centre, or `at` = [fx, fy] fractions of its box) */
  async to(target, { ms = 650, at = [0.5, 0.5] } = {}) {
    const b = await this.box(target);
    await this.glide(b.x + b.width * at[0], b.y + b.height * at[1], ms);
    return b;
  }
  async click(target, opts = {}) {
    await this.to(target, opts);
    await sleep(opts.pause ?? 180);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
  }
  /** type like a person: per-key delay with a little jitter */
  async type(text, { cps = 14 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(1000 / cps + ((ch.charCodeAt(0) * 37) % 40) - 20);
    }
  }
}

/** smooth-scroll the window (or a scroll container) to y over `ms` */
export async function smoothScroll(page, y, ms = 900, selector = null) {
  await page.evaluate(
    ([y, ms, selector]) =>
      new Promise((res) => {
        const el = selector ? document.querySelector(selector) : null;
        const get = () => (el ? el.scrollTop : window.scrollY);
        const set = (v) => (el ? (el.scrollTop = v) : window.scrollTo(0, v));
        const from = get();
        const to = typeof y === "number" ? y : from;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          set(from + (to - from) * e);
          if (k < 1) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      }),
    [y, ms, selector],
  );
}

/** scroll so an element's top sits `offset` px below the viewport top */
export async function scrollToEl(page, target, { offset = 110, ms = 900 } = {}) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  const y = await loc.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset, { timeout: 4000 }).catch((e) => {
    console.warn(`    ! scrollToEl ${typeof target === "string" ? target : "(locator)"}: ${e.message.split("\n")[0]}`);
    return null;
  });
  if (y == null) return;
  await smoothScroll(page, Math.max(0, y), ms);
}

/** run `fn(page, hand, at)` where `at(sec)` waits until `sec` seconds after the mark */
export function clock() {
  let zero = Date.now();
  return {
    reset() {
      zero = Date.now();
    },
    now() {
      return (Date.now() - zero) / 1000;
    },
    async at(sec) {
      const wait = zero + sec * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
    },
  };
}
