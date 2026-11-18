"""Shrink the committed PNGs: optional 256-colour quantising (flat artwork and UI captures
survive it), then lossless oxipng. Needs `pip install pyoxipng pillow`.

    python3 brand/scripts/optimize.py <png>...            # lossless only
    python3 brand/scripts/optimize.py --quantize <png>...  # palette first, then lossless
"""
import sys
from pathlib import Path

import oxipng
from PIL import Image

args = sys.argv[1:]
quantize = "--quantize" in args
for name in (a for a in args if not a.startswith("--")):
    p = Path(name)
    before = p.stat().st_size
    if quantize:
        im = Image.open(p)
        rgba = im.mode in ("RGBA", "LA", "P")
        im = im.convert("RGBA" if rgba else "RGB")
        q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE if rgba else Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        q.save(p, optimize=True)
    oxipng.optimize(p, level=4, strip=oxipng.StripChunks.safe())
    print(f"{p}: {before // 1024} KB -> {p.stat().st_size // 1024} KB")
