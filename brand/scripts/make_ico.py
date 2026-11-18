"""favicon.ico from the per-size masters (16 and 32 use the small-size master, 48 the display
master), then palette-optimise every PNG in the icon folder (flat artwork: 256 colours is
lossless to the eye and a fraction of the bytes).

    python3 brand/scripts/make_ico.py brand/icons
"""
import sys
from pathlib import Path

from PIL import Image

out = Path(sys.argv[1])
frames = [Image.open(out / f"favicon-{n}.png").convert("RGBA") for n in (16, 32, 48)]
frames[-1].save(out / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)], append_images=frames[:-1])

for p in sorted(out.rglob("*.png")):
    im = Image.open(p).convert("RGBA")
    # keep full alpha: quantize RGBA with the fast octree method, which supports transparency
    q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    q.save(p, optimize=True)

for n in (16, 32, 48):
    (out / f"favicon-{n}.png").unlink()
print("favicon.ico:", [s for s in Image.open(out / "favicon.ico").info.get("sizes", [])])
