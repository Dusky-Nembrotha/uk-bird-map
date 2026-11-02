"""Draw the app icons.

    python3 -m src.icons

Written rather than drawn by hand so the set stays consistent and can be
regenerated when the palette moves. The motif is the thing the app actually
shows: a few birds on their tracks, lime and amber on the near-black the
migration view uses, which is also what makes a small icon legible - a map
thumbnail at 48px is a grey smudge, three bright arcs are not.

Maskable icons keep their content inside the middle 80%, because Android
crops them to whatever shape the launcher prefers.
"""
import math
from PIL import Image, ImageDraw

from .util import log, setup_logging
from .config import ROOT

OUT = ROOT / "web" / "icons"

BG = (7, 9, 12)
LIME = (169, 227, 75)
WARM = (255, 193, 54)
PALE = (244, 250, 255)

# Each bird: where it ends up, the heading it came in on, how long a track it
# drags, and its colour. Spread to fill the square - four big marks read at
# 48px where five small ones turn to grit.
BIRDS = [
    (0.26, 0.74, 236, 0.40, WARM),
    (0.74, 0.26, 214, 0.44, LIME),
    (0.70, 0.70, 250, 0.32, PALE),
    (0.33, 0.33, 196, 0.30, LIME),
]


def _draw(size, inset):
    """One icon. `inset` shrinks the artwork for the maskable safe zone."""
    ss = 4                      # supersample, then downscale to antialias
    S = size * ss
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img, "RGBA")

    # A soft lift towards the top left, so the square is not a flat block.
    for i in range(14):
        f = i / 14
        r = int(S * (0.95 - f * 0.55))
        d.ellipse([-r // 3, -r // 3, r, r], fill=(24, 40, 30, 9))

    m = (1 - inset) / 2         # margin as a fraction of the side
    def at(u, v):
        return ((m + u * inset) * S, (m + v * inset) * S)

    for u, v, deg, length, col in BIRDS:
        hx, hy = at(u, v)
        a = math.radians(deg)
        # The track, drawn as a tapering curve of circles rather than a line:
        # it thins and fades towards the tail, which is what the flock does.
        steps = 54
        for i in range(steps, 0, -1):
            t = i / steps
            # A gentle bow, so no two tracks are parallel rules.
            bow = math.sin(t * math.pi) * S * 0.030 * inset
            px = hx - math.cos(a) * length * S * t * inset + math.sin(a) * bow
            py = hy - math.sin(a) * length * S * t * inset - math.cos(a) * bow
            # Tapered rather than faded away to nothing: a track that thins to
            # one pixel has vanished by the time the launcher is done with it.
            fade = (1 - t) ** 0.85
            r = max(1.2, S * 0.021 * inset * fade)
            d.ellipse([px - r, py - r, px + r, py + r],
                      fill=col + (int(60 + 195 * fade),))
        # The bird itself: a halo with a crisp core, as on the map.
        for r, alpha in ((S * 0.072 * inset, 40), (S * 0.044 * inset, 80)):
            d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=col + (alpha,))
        r = S * 0.0235 * inset
        d.ellipse([hx - r, hy - r, hx + r, hy + r], fill=PALE + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main():
    setup_logging(False)
    OUT.mkdir(parents=True, exist_ok=True)
    # 180 is what iOS asks for; 192 and 512 are what the manifest declares.
    for name, size, inset in (("icon-192.png", 192, 0.88),
                              ("icon-512.png", 512, 0.88),
                              ("icon-maskable-512.png", 512, 0.62),
                              ("apple-touch-icon.png", 180, 0.88)):
        _draw(size, inset).save(OUT / name)
        log.info("wrote %s", OUT / name)


if __name__ == "__main__":
    main()
