#!/usr/bin/env python3
"""
Build the app icon set from assets/brand/logo-mark.webp.

The mark ships as glow artwork on pure black. Two things follow.

First, the icon has to sit on the app's own background (#070D18), not on #000000, or the
icon reads a shade colder than every screen behind it. The glow is additive, so the black
keys out cleanly by luminance and the mark composites onto the new ground without a halo.

Second, iOS draws this thing at 40 pt as well as 1024. At that size the spray speckle and
the drips are each about one pixel and turn to grey mush around the D, which reads as dirt
on the lens rather than as paint. So the small sizes are not plain downscales: the speckle
is thresholded away first and only the strokes survive. `SPECKLE_FLOOR` is where that cut
sits, measured rather than guessed — see `report()`.

Run:  python3 scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
MARK = ROOT / "assets/brand/logo-mark.webp"
OUT = ROOT / "assets/images"

BG = (0x07, 0x0D, 0x18)

# Fraction of the canvas the mark spans. iOS masks the icon into a squircle that eats the
# corners, so the artwork is inset rather than bled to the edge.
INSET = 0.86

# Alpha below this is speckle, not stroke. At 1024 the speckle is part of the texture; at
# 120 and below it is noise. See report() for the measurement behind the number.
SPECKLE_FLOOR = 0.42


def keyed() -> Image.Image:
    """The mark with its black ground keyed out, cropped to the artwork."""
    src = Image.open(MARK).convert("RGB")
    px = src.load()
    w, h = src.size
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # Luminance IS the alpha for additive glow art on black: a pixel that is 30%
            # as bright as the stroke was 30% covered by paint.
            a = max(r, g, b)
            if a == 0:
                op[x, y] = (0, 0, 0, 0)
            else:
                # Un-premultiply so the colour stays saturated when it lands on a lighter
                # ground; without this the dim edges of the glow go grey.
                s = 255 / a
                op[x, y] = (min(255, int(r * s)), min(255, int(g * s)), min(255, int(b * s)), a)
    return out.crop(out.getbbox())


def fit(art: Image.Image, size: int, inset: float = INSET) -> Image.Image:
    """Centre `art` on a transparent square of `size`, spanning `inset` of it."""
    box = round(size * inset)
    scale = min(box / art.width, box / art.height)
    a = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(a, ((size - a.width) // 2, (size - a.height) // 2), a)
    return canvas


def despeckle(art: Image.Image) -> Image.Image:
    """Drop the spray grain, keep the strokes. For sizes where grain becomes mush."""
    r, g, b, a = art.split()
    # Median first so isolated dots die and stroke edges survive, then a hard cut.
    a = a.filter(ImageFilter.MedianFilter(size=5))
    floor = round(SPECKLE_FLOOR * 255)
    a = a.point(lambda v: 0 if v < floor else min(255, round((v - floor) * 255 / (255 - floor))))
    return Image.merge("RGBA", (r, g, b, a))


def onto(art: Image.Image, bg=BG) -> Image.Image:
    flat = Image.new("RGB", art.size, bg)
    flat.paste(art, (0, 0), art)
    return flat


def report(art: Image.Image) -> None:
    """Why SPECKLE_FLOOR is 0.42 and not a guess."""
    a = art.split()[3]
    hist = a.histogram()
    lit = sum(hist[1:])
    below = sum(hist[1 : round(SPECKLE_FLOOR * 255)])
    print(f"mark: {art.width}x{art.height} art box, {lit:,} lit pixels")
    print(f"      {below:,} ({below / lit:.1%}) sit below the speckle floor — that is the grain")
    print(f"      {lit - below:,} ({1 - below / lit:.1%}) are stroke and survive to 40 pt")


def main() -> None:
    art = keyed()
    report(art)
    thin = despeckle(art)

    jobs = [
        # iOS + the store. Opaque, square, unrounded: iOS applies its own mask.
        ("icon.png", 1024, art, True),
        # Web.
        ("favicon.png", 64, thin, True),
        # Splash: alpha, so app.json's backgroundColor shows through.
        ("splash-icon.png", 512, art, False),
        # Android adaptive: the foreground is inset further because the launcher crops it
        # to a circle on most devices, and the monochrome layer is a silhouette.
        ("android-icon-foreground.png", 1024, art, False),
        ("android-icon-background.png", 1024, None, True),
        ("android-icon-monochrome.png", 1024, thin, False),
    ]

    for name, size, source, opaque in jobs:
        if source is None:
            img: Image.Image = Image.new("RGB", (size, size), BG)
        else:
            inset = 0.62 if name.startswith("android-icon") else INSET
            img = fit(source, size, inset)
            if name == "android-icon-monochrome.png":
                r, g, b, a = img.split()
                white = Image.new("L", img.size, 255)
                img = Image.merge("RGBA", (white, white, white, a))
            if opaque:
                img = onto(img)
        img.save(OUT / name, "PNG", optimize=True)
        print(f"  {name:32} {size}x{size} {'opaque' if opaque else 'alpha'}")


if __name__ == "__main__":
    main()
