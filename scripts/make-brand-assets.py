"""
Makes MineMuster's app assets from its two logo renders in assets/brand/source:
the lockup (the MM mark over MINE MUSTER) and the mark on its own, both silver on black.

    python3 scripts/make-brand-assets.py

Writes, in assets/:
    brand/minemuster-logo.webp   the lockup for the sign-in screen, 840 px wide (280 points at 3x)
    icon.png                     the app icon: the mark on black, opaque, 1024 square
    android-icon-foreground.png  the mark inside the adaptive icon's safe circle, on transparent
    android-icon-background.png  solid black
    android-icon-monochrome.png  the mark as one solid shape, for themed icons
    splash-icon.png              the lockup on transparent, for the black launch screen
    favicon.png                  the mark, 48 px, for a browser tab

The renders are silver on black. "Unscreen" turns the black into transparency: a pixel's opacity
is its brightness above a black point, and its colour is what gives back the render over black.
Laid over any dark colour, the result looks the same as the render screened onto it, glow and all.
Remake the assets with this script whenever the renders change; do not edit them by hand.
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
SOURCE = os.path.join(ASSETS, 'brand', 'source')
LOCKUP = Image.open(os.path.join(SOURCE, 'minemuster-lockup.png')).convert('RGB')
MARK = Image.open(os.path.join(SOURCE, 'minemuster-mark.png')).convert('RGB')


def unscreen(img, black=10):
    a = np.asarray(img).astype(np.float32)
    m = a.max(axis=2)
    alpha = np.clip((m - black) / (255 - black), 0, 1)
    with np.errstate(divide='ignore', invalid='ignore'):
        col = np.where(m[..., None] > black, (a - black) / (m[..., None] - black), 1.0)
    col = np.clip(col, 0, 1)
    return Image.fromarray(np.dstack([col * 255, alpha * 255]).round().astype(np.uint8), 'RGBA')


def bbox(img, t):
    a = np.asarray(img.convert('RGB')).max(axis=2)
    ys, xs = np.where(a > t)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def pad_box(box, pad, size):
    x0, y0, x1, y1 = box
    return max(0, x0 - pad), max(0, y0 - pad), min(size[0], x1 + pad), min(size[1], y1 + pad)


def fit(img, w):
    return img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)


LOCK_BOX = pad_box(bbox(LOCKUP, 10), 8, LOCKUP.size)
MARK_BOX = pad_box(bbox(MARK, 14), 10, MARK.size)


def whole_mark(canvas_size, width, rgba=False):
    """The whole mark render, scaled so the mark itself is `width` wide and centred. Its glow
    fades out into the black instead of stopping at a crop line."""
    k = width / (MARK_BOX[2] - MARK_BOX[0])
    src = unscreen(MARK) if rgba else MARK
    big = src.resize((round(MARK.width * k), round(MARK.height * k)), Image.LANCZOS)
    cx = (MARK_BOX[0] + MARK_BOX[2]) / 2 * k
    cy = (MARK_BOX[1] + MARK_BOX[3]) / 2 * k
    canvas = Image.new('RGBA' if rgba else 'RGB', canvas_size, (0, 0, 0, 0) if rgba else (0, 0, 0))
    canvas.paste(big, (round(canvas_size[0] / 2 - cx), round(canvas_size[1] / 2 - cy)), big if rgba else None)
    return canvas


def main():
    lock = unscreen(LOCKUP.crop(LOCK_BOX))
    fit(lock, 840).save(os.path.join(ASSETS, 'brand', 'minemuster-logo.webp'), 'WEBP', quality=90, method=6)
    fit(lock, 1024).save(os.path.join(ASSETS, 'splash-icon.png'), optimize=True)

    whole_mark((1024, 1024), 820).save(os.path.join(ASSETS, 'icon.png'), optimize=True)
    # The adaptive icon shows a circle 66% of the canvas across at the least: a 600 px mark fits inside it.
    whole_mark((1024, 1024), 600, rgba=True).save(os.path.join(ASSETS, 'android-icon-foreground.png'), optimize=True)
    Image.new('RGB', (1024, 1024), (0, 0, 0)).save(os.path.join(ASSETS, 'android-icon-background.png'), optimize=True)

    lum = np.asarray(fit(MARK.crop(MARK_BOX), 600).convert('L')).astype(np.float32) / 255
    solid = np.clip((lum - 0.12) / (0.40 - 0.12), 0, 1) * 255
    shape = Image.fromarray(np.dstack([np.full_like(solid, 255)] * 3 + [solid]).astype(np.uint8), 'RGBA')
    mono = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    mono.alpha_composite(shape, ((1024 - shape.width) // 2, (1024 - shape.height) // 2))
    mono.save(os.path.join(ASSETS, 'android-icon-monochrome.png'), optimize=True)

    whole_mark((480, 480), 460).resize((48, 48), Image.LANCZOS).save(os.path.join(ASSETS, 'favicon.png'), optimize=True)


if __name__ == '__main__':
    main()
