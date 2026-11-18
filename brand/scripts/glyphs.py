"""Shape text with HarfBuzz and return SVG path data (the brand's text-to-outline step).

Every logo SVG is built from outlines, never live text, so it renders identically anywhere
without the fonts installed. Fraunces and Schibsted Grotesk are under the SIL Open Font
License 1.1, which allows outlining glyphs into artwork (the outlines are not a font).
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parent.parent / ".fonts"
_cache: dict[str, tuple[bytes, int]] = {}


def _font_bytes(name: str) -> tuple[bytes, int]:
    """woff2 -> plain sfnt bytes (HarfBuzz doesn't read woff2), plus unitsPerEm."""
    if name not in _cache:
        path = FONTS / name
        if not path.exists():
            raise SystemExit(f"missing {path}: run brand/scripts/fetch-fonts.sh first")
        tt = TTFont(path)
        tt.flavor = None
        buf = io.BytesIO()
        tt.save(buf)
        _cache[name] = (buf.getvalue(), tt["head"].unitsPerEm)
    return _cache[name]


def _num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


@dataclass
class Run:
    d: str  # SVG path data, y-down, origin at the baseline start
    width: float  # advance width in output units
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1 (y-down; y0 is above the baseline, negative)


class _BBoxPen:
    def __init__(self) -> None:
        self.pts: list[tuple[float, float]] = []

    def moveTo(self, p):
        self.pts.append(p)

    def lineTo(self, p):
        self.pts.append(p)

    def curveTo(self, *ps):
        self.pts.extend(ps)

    def qCurveTo(self, *ps):
        self.pts.extend(p for p in ps if p is not None)

    def closePath(self):
        pass

    def endPath(self):
        pass


def shape(text: str, font: str, size: float, axes: dict[str, float], tracking: float = 0.0, x: float = 0.0, y: float = 0.0) -> Run:
    """Outline `text` at `size` output units per em, baseline at (x, y). tracking in em."""
    data, upem = _font_bytes(font)
    face = hb.Face(data)
    f = hb.Font(face)
    f.set_variations(axes)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(f, buf, {"kern": True, "liga": True})
    s = size / upem
    svg = SVGPathPen(None, ntos=_num)
    bb = _BBoxPen()
    pen_x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        gx = x + (pen_x + pos.x_offset) * s
        gy = y - pos.y_offset * s
        m = (s, 0, 0, -s, gx, gy)
        f.draw_glyph_with_pen(info.codepoint, TransformPen(svg, m))
        f.draw_glyph_with_pen(info.codepoint, TransformPen(bb, m))
        pen_x += pos.x_advance + tracking * upem
    xs = [p[0] for p in bb.pts] or [x]
    ys = [p[1] for p in bb.pts] or [y]
    return Run(svg.getCommands(), pen_x * s - tracking * size, (min(xs), min(ys), max(xs), max(ys)))
