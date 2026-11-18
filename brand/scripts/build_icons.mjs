// App icons from the outlined mark (brand/logo/geometry.json, built by build_logo.py):
// favicon.svg (light/dark), PNG sizes for the web app, PWA and the MV3 extension, then
// favicon.ico via scripts/make_ico.py. Copies the wired ones into apps/web and apps/extension.
//
//   node brand/scripts/build_icons.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND, ROOT, launch, png } from "./lib.mjs";

const geo = JSON.parse(readFileSync(join(BRAND, "logo", "geometry.json"), "utf8"));
const OUT = join(BRAND, "icons");
mkdirSync(join(OUT, "extension"), { recursive: true });

const WAYS = {
  light: { tile: "#1c1915", j: "#f6f1e7", dot: "#ef7a4f" }, // ink tile: reads on light and dark chrome
  dark: { tile: "#f2ede3", j: "#161411", dot: "#b8401c" }, // paper tile, for dark browser chrome
};

/** The mark's inner artwork (J + full stop) in the 100-unit tile space. */
const art = (g, w) =>
  `<path d="${g.j}" fill="${w.j}"/><circle cx="${g.dot[0]}" cy="${g.dot[1]}" r="${g.dot[2]}" fill="${w.dot}"/>`;

/**
 * One icon as SVG. `pad`: transparent margin (tile units) around a rounded tile.
 * `bleed`: a full-bleed square (no rounding, no transparency) with the art scaled by `art`
 * about the centre — for apple-touch and maskable icons, whose platform applies the mask.
 */
function icon({ master = "display", way = "light", pad = 0, bleed = false, scale = 1 }) {
  const g = geo[master];
  const w = WAYS[way];
  const inner = `translate(${50 - 50 * scale} ${50 - 50 * scale}) scale(${scale})`;
  if (bleed) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${w.tile}"/><g transform="${inner}">${art(g, w)}</g></svg>`;
  }
  const s = (100 - 2 * pad) / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(${pad} ${pad}) scale(${s})"><rect width="100" height="100" rx="${g.rx}" fill="${w.tile}"/><g transform="${inner}">${art(g, w)}</g></g></svg>`;
}

// favicon.svg: the small-size master; an ink tile on light chrome, a paper tile on dark.
const t = geo.text;
const faviconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<style>.d{display:none}@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}</style>` +
  `<g class="l"><rect width="100" height="100" rx="${t.rx}" fill="${WAYS.light.tile}"/>${art(t, WAYS.light)}</g>` +
  `<g class="d"><rect width="100" height="100" rx="${t.rx}" fill="${WAYS.dark.tile}"/>${art(t, WAYS.dark)}</g>` +
  `</svg>\n`;
writeFileSync(join(OUT, "favicon.svg"), faviconSvg);

const JOBS = [
  // name, px, svg
  ["favicon-16.png", 16, icon({ master: "text" })],
  ["favicon-32.png", 32, icon({ master: "text" })],
  ["favicon-48.png", 48, icon({ master: "display" })],
  ["apple-touch-icon.png", 180, icon({ bleed: true, scale: 0.86 })],
  ["icon-192.png", 192, icon({})],
  ["icon-512.png", 512, icon({})],
  // maskable: the art must sit inside the central 80% circle; 0.7 keeps J and dot well inside
  ["icon-maskable-512.png", 512, icon({ bleed: true, scale: 0.7 })],
  ["extension/icon-16.png", 16, icon({ master: "text" })],
  ["extension/icon-32.png", 32, icon({ master: "text" })],
  ["extension/icon-48.png", 48, icon({ master: "display", pad: 2 })],
  // Chrome's guidance: 96px of artwork with 16px of transparent padding in the 128px icon
  ["extension/icon-128.png", 128, icon({ master: "display", pad: 12.5 })],
];

const browser = await launch();
for (const [name, px, svg] of JOBS) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${px}" height="${px}" `)}</body></html>`;
  await png(browser, { html, width: px, height: px, scale: 1, out: join(OUT, name), transparent: true });
}
await browser.close();

// favicon.ico (16/32/48) + palette-optimise the PNGs
execFileSync("python3", [join(BRAND, "scripts", "make_ico.py"), OUT], { stdio: "inherit" });

// wire: Next App Router file conventions + PWA manifest icons + the extension manifest
const web = join(ROOT, "apps", "web");
mkdirSync(join(web, "public", "icons"), { recursive: true });
mkdirSync(join(ROOT, "apps", "extension", "icons"), { recursive: true });
const copies = [
  ["favicon.ico", join(web, "app", "favicon.ico")],
  ["favicon.svg", join(web, "app", "icon.svg")],
  ["apple-touch-icon.png", join(web, "app", "apple-icon.png")],
  ["icon-192.png", join(web, "public", "icons", "icon-192.png")],
  ["icon-512.png", join(web, "public", "icons", "icon-512.png")],
  ["icon-maskable-512.png", join(web, "public", "icons", "icon-maskable-512.png")],
  ...[16, 32, 48, 128].map((n) => [`extension/icon-${n}.png`, join(ROOT, "apps", "extension", "icons", `icon-${n}.png`)]),
];
for (const [from, to] of copies) copyFileSync(join(OUT, from), to);
console.log(`icons: ${JOBS.length} PNGs + favicon.svg + favicon.ico in brand/icons; ${copies.length} copied into apps/`);
