// Render the brand's HTML sources (brand/src) to PNG and PDF.
//
//   node brand/scripts/render.mjs [name-filter]
//
// Needs brand/.fonts (fetch-fonts.sh), brand/logo (build_logo.py) and the product captures in
// brand/.out/captures (capture.mjs). Posters go to brand/posters (or $BRAND_OUT), share images
// and launch cards to brand/social, the brand sheet to brand/; then run optimize.py on the PNGs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND, ROOT, launch } from "./lib.mjs";

const SRC = join(BRAND, "src");
const CAP = join(BRAND, ".out", "captures");
const OUT = process.env.BRAND_OUT || join(BRAND, "posters");
mkdirSync(OUT, { recursive: true });
for (const d of ["posters", "social"]) mkdirSync(join(BRAND, d), { recursive: true });

const MM = 96 / 25.4; // CSS px per mm
const A3 = { w: 303 * MM, h: 426 * MM, bleed: 3 * MM }; // trim 297 x 420 + 3 mm bleed

/** ANSI SGR (what the CLI prints) -> spans styled by brand.css's .term classes. */
export function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let bold = false, dim = false, color = "";
  let out = "";
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) {
      if (!part) continue;
      const cls = [bold && "a-b", dim && "a-d", color].filter(Boolean).join(" ");
      out += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
      continue;
    }
    for (const c of (m[1] || "0").split(";").map(Number)) {
      if (c === 0) { bold = dim = false; color = ""; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) bold = dim = false;
      else if (c === 39) color = "";
      else color = { 31: "a-r", 32: "a-g", 33: "a-y", 36: "a-c" }[c] ?? color;
    }
  }
  // the "$ jobflow …" line capture.mjs prepends
  return out.replace(/^\$ (.*)$/m, '<span class="prompt">$</span> <span class="a-b">$1</span>');
}

/** Fill every [data-ansi="file.ansi"] (optional data-lines="a-b", 1-based) with the capture. */
async function fillAnsi(page) {
  const want = await page.$$eval("[data-ansi]", (els) => els.map((e) => ({ f: e.dataset.ansi, l: e.dataset.lines || "" })));
  const html = want.map(({ f, l }) => {
    const p = join(CAP, f);
    if (!existsSync(p)) throw new Error(`missing capture ${f}: run brand/scripts/capture.mjs`);
    let lines = readFileSync(p, "utf8").replace(/\s+$/, "").split("\n");
    if (l) {
      // "1,8-16,21": 1-based lines and ranges
      lines = l.split(",").flatMap((r) => {
        const [a, b] = r.split("-").map(Number);
        return lines.slice(a - 1, b || a);
      });
    }
    return ansiToHtml(lines.join("\n"));
  });
  await page.$$eval("[data-ansi]", (els, html) => els.forEach((e, i) => (e.innerHTML = html[i])), html);
}

/** Where the submit button sits in the review-gate capture, as CSS % vars for the callout. */
async function gateVars(page) {
  const json = join(CAP, "review-gate.json");
  const png = join(CAP, "review-gate.png");
  if (!existsSync(json) || !existsSync(png)) return;
  const { submit, width } = JSON.parse(readFileSync(json, "utf8"));
  const height = readFileSync(png).readUInt32BE(20) / 2; // IHDR height, captured at 2x
  await page.evaluate(
    (v) => Object.entries(v).forEach(([k, x]) => document.documentElement.style.setProperty(k, x)),
    {
      "--gate-x": `${(submit.x / width) * 100}%`,
      "--gate-y": `${(submit.y / height) * 100}%`,
      "--gate-w": `${(submit.width / width) * 100}%`,
      "--gate-h": `${(submit.height / height) * 100}%`,
    },
  );
}

/**
 * Draw the mark into every <svg data-mark="display|text"> from logo/geometry.json, with
 * data-tile / data-j / data-dot colours (the brand sheet's do/don't tiles need recoloured
 * marks). data-j="none" knocks the J out of the tile.
 */
async function fillMarks(page) {
  const geo = JSON.parse(readFileSync(join(BRAND, "logo", "geometry.json"), "utf8"));
  await page.$$eval(
    "svg[data-mark]",
    (els, geo) =>
      els.forEach((el, i) => {
        const g = geo[el.dataset.mark] ?? geo.display;
        const { tile = "#1c1915", j = "#f6f1e7", dot = "#ef7a4f" } = el.dataset;
        el.setAttribute("viewBox", "0 0 100 100");
        const [cx, cy, r] = g.dot;
        el.innerHTML =
          j === "none"
            ? `<mask id="m${i}"><rect width="100" height="100" fill="#fff"/><path d="${g.j}" fill="#000"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/></mask><rect width="100" height="100" rx="${g.rx}" fill="${tile}" mask="url(#m${i})"/>`
            : `<rect width="100" height="100" rx="${g.rx}" fill="${tile}"/><path d="${g.j}" fill="${j}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${dot}"/>`;
      }),
    geo,
  );
}

async function open(browser, src, { width, height, scale, format }) {
  const page = await browser.newPage({ viewport: { width: Math.ceil(width), height: Math.ceil(height) }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(join(SRC, src)).href);
  if (format) await page.evaluate((f) => (document.body.dataset.format = f), format);
  await fillAnsi(page);
  await gateVars(page);
  await fillMarks(page);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  // every image must have loaded, and nothing may overflow its box (clipped text)
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3,p,li,.display,.lede,.kicker,b,span")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible")
      .map((e) => e.textContent.slice(0, 40)),
  );
  if (clipped.length) console.warn(`  ${src}: clipped →`, clipped);
  return page;
}

const POSTERS = ["poster-ranked", "poster-review-gate", "poster-local"];
const JOBS = [
  ...POSTERS.flatMap((p) => [
    { src: `${p}.html`, kind: "a3", out: p },
    { src: `${p}.html`, kind: "social", out: `${p}-4x5` },
  ]),
  { src: "share.html", kind: "png", w: 1280, h: 640, scale: 1, out: "social/github-social-preview.png" },
  { src: "share.html", kind: "png", w: 1200, h: 630, scale: 1, out: "social/og-image.png" },
  { src: "readme-banner.html", kind: "png", w: 1280, h: 400, scale: 2, format: "light", out: "social/readme-banner-light.png" },
  { src: "readme-banner.html", kind: "png", w: 1280, h: 400, scale: 2, format: "dark", out: "social/readme-banner-dark.png" },
  { src: "card-match.html", kind: "png", w: 1080, h: 1080, scale: 1, out: "social/launch-1-match-cards.png" },
  { src: "card-pay.html", kind: "png", w: 1080, h: 1080, scale: 1, out: "social/launch-2-pay.png" },
  { src: "card-mcp.html", kind: "png", w: 1080, h: 1080, scale: 1, out: "social/launch-3-mcp.png" },
  { src: "brand-sheet.html", kind: "sheet", out: "brand-sheet" },
];

const filter = process.argv[2];
const browser = await launch();
for (const j of JOBS) {
  if (filter && !j.out.includes(filter) && !j.src.includes(filter)) continue;
  if (!existsSync(join(SRC, j.src))) { console.warn(`skip ${j.src} (no source yet)`); continue; }
  if (j.kind === "a3") {
    // print PDF at full bleed size (vector type and rules; the 2x captures land at ≈ 300 dpi)
    // + the trimmed page as a 2x PNG (2245 x 3175, ≈ 190 dpi: screens and small prints)
    const page = await open(browser, j.src, { width: A3.w, height: A3.h, scale: 2, format: "a3" });
    await page.pdf({ path: join(OUT, `${j.out}-A3-bleed.pdf`), width: "303mm", height: "426mm", printBackground: true, pageRanges: "1" });
    const clip = { x: A3.bleed, y: A3.bleed, width: A3.w - 2 * A3.bleed, height: A3.h - 2 * A3.bleed };
    await page.screenshot({ path: join(OUT, `${j.out}-A3@2x.png`), clip });
    await page.close();
  } else if (j.kind === "social") {
    const page = await open(browser, j.src, { width: 1080, height: 1350, scale: 2, format: "social" });
    await page.screenshot({ path: join(OUT, `${j.out}@2x.png`) });
    await page.close();
  } else if (j.kind === "sheet") {
    const W = 420 * MM, H = 297 * MM; // A3 landscape
    const page = await open(browser, j.src, { width: W, height: H, scale: 2 });
    await page.pdf({ path: join(BRAND, `${j.out}.pdf`), width: "420mm", height: "297mm", printBackground: true, pageRanges: "1" });
    await page.screenshot({ path: join(BRAND, `${j.out}.png`) });
    await page.close();
  } else {
    const page = await open(browser, j.src, { width: j.w, height: j.h, scale: j.scale, format: j.format });
    await page.screenshot({ path: join(BRAND, j.out) });
    await page.close();
  }
  console.log("rendered", j.out);
}
await browser.close();

// wire the share image into the web app (App Router file conventions)
const og = join(BRAND, "social", "og-image.png");
if (existsSync(og)) {
  const app = join(ROOT, "apps", "web", "app");
  const alt = "JobFlow: every job, ranked by how well it fits you. A match card with a score, the reason it fits, and a flag to check.";
  for (const name of ["opengraph-image", "twitter-image"]) {
    copyFileSync(og, join(app, `${name}.png`));
    writeFileSync(join(app, `${name}.alt.txt`), alt);
  }
}
