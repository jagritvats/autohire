"""Build the JobFlow logo system as outlined SVG (no live text, no font dependency).

    python3 brand/scripts/build_logo.py

Writes brand/logo/*.svg and brand/logo/geometry.json (the mark's path data, reused by the
icon builder and the web app's inline mark). See brand/README.md for the concept and rules.
"""
from __future__ import annotations

import json
from pathlib import Path

from glyphs import shape

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "logo"

# Palette (docs/internal/DESIGN.md, Concept A)
INK = "#1c1915"
PAPER = "#f6f1e7"
NIGHT = "#161411"
NIGHT_INK = "#f2ede3"
VERMILION = "#b8401c"  # the accent on paper
EMBER = "#ef7a4f"  # the same accent on night/ink

ROMAN = "Fraunces-VF.woff2"
ITALIC = "Fraunces-Italic-VF.woff2"

# Two optical masters of the same mark, the way Fraunces itself has an optical-size axis:
# DISPLAY for 48px and up (finer contrast), TEXT for 16-32px (sturdier stems, bigger dot).
MASTERS = {
    "display": dict(axes={"wght": 700, "opsz": 72, "SOFT": 100, "WONK": 0}, size=88, dot=0.19, gap=0.045, rx=22),
    "text": dict(axes={"wght": 800, "opsz": 9, "SOFT": 100, "WONK": 0}, size=108, dot=0.22, gap=0.03, rx=18),
}
WORD_ROMAN = {"wght": 600, "opsz": 48, "SOFT": 100, "WONK": 0}
WORD_ITALIC = {"wght": 400, "opsz": 48, "SOFT": 100, "WONK": 0}


def mark_geometry(master: str) -> dict:
    """The mark in a 100x100 tile: J path, the full stop (circle), the tile radius."""
    m = MASTERS[master]
    probe = shape("J", ROMAN, m["size"], m["axes"])
    x0, y0, x1, _ = probe.bbox
    cap = -y0
    dd = m["dot"] * m["size"]
    gap = m["gap"] * m["size"]
    width = (x1 - x0) + gap + dd
    ox = (100 - width) / 2 - x0
    # optical centre: the block sits a hair above the geometric centre
    base = 50 + cap / 2 - 1.5
    j = shape("J", ROMAN, m["size"], m["axes"], x=ox, y=base)
    cx = ox + x1 + gap + dd / 2
    return {"j": j.d, "dot": [round(cx, 2), round(base - dd / 2, 2), round(dd / 2, 2)], "rx": m["rx"], "cap": round(cap, 2), "base": round(base, 2)}


def wordmark(size: float, x: float, y: float, dot: bool) -> tuple[str, str, float, list[float] | None, float]:
    """'Job' roman + 'Flow' italic (as in the app header), optional full stop.
    Returns (roman d, italic d, right edge, dot circle, cap height)."""
    job = shape("Job", ROMAN, size, WORD_ROMAN, tracking=-0.02, x=x, y=y)
    flow = shape("Flow", ITALIC, size, WORD_ITALIC, tracking=-0.02, x=x + job.width + 0.012 * size, y=y)
    cap = -job.bbox[1] + y
    right = flow.bbox[2]
    circle = None
    if dot:
        r = cap * 0.13
        cx = right + 0.05 * size + r
        circle = [round(cx, 2), round(y - r, 2), round(r, 2)]
        right = cx + r
    return job.d, flow.d, right, circle, cap


def svg(w: float, h: float, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def circle(c: list[float], fill: str) -> str:
    return f'<circle cx="{c[0]}" cy="{c[1]}" r="{c[2]}" fill="{fill}"/>'


# Colourways. On an ink tile the dot is EMBER, on a paper tile VERMILION: the accent always
# belongs to the surface it sits on (the app's light/dark accent pair).
WAYS = {
    "light": dict(tile=INK, j=PAPER, dot=EMBER, word=INK, wdot=VERMILION),  # for paper / light grounds
    "dark": dict(tile=NIGHT_INK, j=NIGHT, dot=VERMILION, word=NIGHT_INK, wdot=EMBER),  # for night / dark grounds
    "mono-black": dict(tile="#000", j=None, dot=None, word="#000", wdot="#000"),  # knock-out, one colour
    "mono-white": dict(tile="#fff", j=None, dot=None, word="#fff", wdot="#fff"),
}


def tile_body(g: dict, way: dict, x: float, y: float, s: float, uid: str) -> str:
    """The tile at (x, y), s units square. Mono colourways knock the J and dot out."""
    t = f'transform="translate({x:.2f} {y:.2f}) scale({s / 100:.5f})"'
    if way["j"] is None:
        return (
            f'<mask id="{uid}"><rect width="100" height="100" fill="#fff"/><path d="{g["j"]}" fill="#000"/>{circle(g["dot"], "#000")}</mask>'
            f'<g {t}><rect width="100" height="100" rx="{g["rx"]}" fill="{way["tile"]}" mask="url(#{uid})"/></g>'
        )
    return f'<g {t}><rect width="100" height="100" rx="{g["rx"]}" fill="{way["tile"]}"/><path d="{g["j"]}" fill="{way["j"]}"/>{circle(g["dot"], way["dot"])}</g>'


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    geo = {k: mark_geometry(k) for k in MASTERS}
    g = geo["display"]
    files: list[str] = []

    def write(name: str, text: str) -> None:
        (OUT / name).write_text(text)
        files.append(name)

    # word metrics at unit size 100, baseline 0
    _, _, wright, wdot, wcap = wordmark(100, 0, 0, dot=True)
    _, _, wright_nd, _, _ = wordmark(100, 0, 0, dot=False)

    for name, way in WAYS.items():
        sfx = "" if name == "light" else f"-{name}"
        # mark only
        write(f"jobflow-mark{sfx}.svg", svg(100, 100, tile_body(g, way, 0, 0, 100, "k"), "JobFlow"))

        # horizontal: tile H=100; wordmark cap = 0.5 H, baseline on the J's baseline
        H = 100
        size = 0.54 * H / (wcap / 100)
        gap = 0.24 * H
        base = g["base"]
        jd, fd, right, _, _ = wordmark(size, H + gap, base, dot=False)
        body = tile_body(g, way, 0, 0, H, "k") + f'<path d="{jd}" fill="{way["word"]}"/><path d="{fd}" fill="{way["word"]}"/>'
        write(f"jobflow-horizontal{sfx}.svg", svg(right + 1, H, body, "JobFlow"))

        # stacked: tile above, wordmark below, centred
        size_s = 0.62 * H / (wcap / 100)
        ww = wright_nd * size_s / 100
        W = max(ww, H) + 2
        cap_s = wcap * size_s / 100
        base_s = H + 0.24 * H + cap_s
        jd, fd, _, _, _ = wordmark(size_s, (W - ww) / 2, base_s, dot=False)
        body = tile_body(g, way, (W - H) / 2, 0, H, "k") + f'<path d="{jd}" fill="{way["word"]}"/><path d="{fd}" fill="{way["word"]}"/>'
        write(f"jobflow-stacked{sfx}.svg", svg(W, base_s + 0.06 * size_s, body, "JobFlow"))

        # wordmark only, with its full stop (the one place the dot leaves the tile)
        size_w = 100
        base_w = wcap + 1
        jd, fd, right, c, _ = wordmark(size_w, 1, base_w, dot=True)
        body = f'<path d="{jd}" fill="{way["word"]}"/><path d="{fd}" fill="{way["word"]}"/>' + circle(c, way["wdot"])
        write(f"jobflow-wordmark{sfx}.svg", svg(right + 1, base_w + 0.24 * size_w, body, "JobFlow"))

    # the text master (16-32px), for the favicon/extension builder
    gt = geo["text"]
    for name in ("light", "dark"):
        way = WAYS[name]
        sfx = "" if name == "light" else f"-{name}"
        write(f"jobflow-mark-small{sfx}.svg", svg(100, 100, tile_body(gt, way, 0, 0, 100, "k"), "JobFlow"))

    (OUT / "geometry.json").write_text(json.dumps(geo, indent=1) + "\n")

    # the web app draws the mark inline (theme tokens, no request): emit its geometry as TS
    ts = ROOT.parent / "apps" / "web" / "components" / "ui" / "brandMark.ts"
    ts.write_text(
        "// Generated by brand/scripts/build_logo.py from the outlined Fraunces J (SIL OFL 1.1).\n"
        "// Don't edit by hand: change the script and re-run it. 100x100 tile space.\n"
        f'export const MARK_RX = {gt["rx"]};\n'
        f'export const MARK_J = "{gt["j"]}";\n'
        f'export const MARK_DOT = {{ cx: {gt["dot"][0]}, cy: {gt["dot"][1]}, r: {gt["dot"][2]} }} as const;\n'
    )
    print("wrote", len(files), "SVGs + geometry.json to", OUT, "and", ts.name)


if __name__ == "__main__":
    main()
