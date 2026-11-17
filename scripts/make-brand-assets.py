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
    splash-icon.png              the lockup on transparent, for the black launch screen on iOS
    splash-icon-android.png      the mark alone, for Android's launch screen, which shows only a circle
    favicon.png                  the mark as a solid silver shape on black, 48 px, for a browser tab

and, for the website in site/:
    brand/minemuster-logo.webp   the lockup, 1600 px wide, for large screens
    brand/minemuster-logo-1200.webp the lockup, 1200 px wide, for phones at 3x
    brand/minemuster-logo-800.webp  the lockup, 800 px wide, for phones
    brand/minemuster-mark-header.webp  the mark on black for the header, 228 x 144 (76 x 48 CSS px at 3x)
    brand/og-image.png           the link preview: the lockup on black, 1200 x 630
    apple-touch-icon.png         the mark on black, 180 square, for a phone's home screen
    favicon.png                  the same 48 px mark as the app's

The renders are silver on black. "Unscreen" turns the black into transparency: a pixel's opacity
is its brightness above a black point, and its colour is what gives back the render over black.
Laid over any dark colour, the result looks the same as the render screened onto it, glow and all.
Remake the assets with this script whenever the renders change; do not edit them by hand.
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
SITE = os.path.join(ROOT, 'site')
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
    # A plain paste copies the pixels as they are. Pasting an RGBA image through itself as a mask
    # would blend its alpha in a second time and darken it.
    canvas.paste(big, (round(canvas_size[0] / 2 - cx), round(canvas_size[1] / 2 - cy)))
    return canvas


def silhouette(width):
    """The mark as one solid shape, `width` px wide, as an alpha mask: the strokes above a brightness
    threshold, small dark reflections inside them closed up, enclosed holes filled, the glow left out.
    The thin cuts between strokes stay open."""
    lum = np.asarray(MARK.crop(MARK_BOX).convert('L')).astype(np.float32) / 255
    mask = Image.fromarray(((lum > 0.3) * 255).astype(np.uint8), 'L')
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    # Flood the background in from the edge; whatever it cannot reach is inside the shape.
    pad = Image.new('L', (mask.width + 2, mask.height + 2), 255)
    pad.paste(Image.eval(mask, lambda v: 255 - v), (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    solid = Image.fromarray(np.where(np.asarray(pad)[1:-1, 1:-1] == 128, 0, 255).astype(np.uint8), 'L')
    return solid.resize((width, round(solid.height * width / solid.width)), Image.LANCZOS)


def site_header_mark():
    """The mark as the site's header shows it: the 180 px home-screen icon drawn 108 CSS px square
    and seen through a 76 x 48 window, made here at 3x so it is sharp on a phone."""
    return whole_mark((228, 144), round(820 / 1024 * 108 * 3))


def main():
    lock = unscreen(LOCKUP.crop(LOCK_BOX))
    fit(lock, 840).save(os.path.join(ASSETS, 'brand', 'minemuster-logo.webp'), 'WEBP', quality=90, method=6)
    fit(lock, 1024).save(os.path.join(ASSETS, 'splash-icon.png'), optimize=True)

    whole_mark((1024, 1024), 820).save(os.path.join(ASSETS, 'icon.png'), optimize=True)
    # The adaptive icon shows a circle 66% of the canvas across at the least: a 600 px mark fits inside it.
    whole_mark((1024, 1024), 600, rgba=True).save(os.path.join(ASSETS, 'android-icon-foreground.png'), optimize=True)
    Image.new('RGB', (1024, 1024), (0, 0, 0)).save(os.path.join(ASSETS, 'android-icon-background.png'), optimize=True)

    shape = silhouette(600)
    mono = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    mono.paste(Image.new('RGBA', shape.size, (255, 255, 255, 255)), ((1024 - shape.width) // 2, (1024 - shape.height) // 2), shape)
    mono.save(os.path.join(ASSETS, 'android-icon-monochrome.png'), optimize=True)

    # Android 12 and later show the launch image inside a circle 192 dp across, so it gets the mark
    # alone: drawn 192 dp wide (app.json), the mark is 160 dp and its corners stay inside the circle.
    whole_mark((1200, 600), 1000, rgba=True).save(os.path.join(ASSETS, 'splash-icon-android.png'), optimize=True)

    # A browser tab draws this at 16 px, where chrome and glow turn to grey: a solid silver shape reads.
    tab = silhouette(460)
    big = Image.new('RGB', (480, 480), (0, 0, 0))
    big.paste(Image.new('RGB', tab.size, (228, 230, 234)), ((480 - tab.width) // 2, (480 - tab.height) // 2), tab)
    favicon = big.resize((48, 48), Image.LANCZOS)
    favicon.save(os.path.join(ASSETS, 'favicon.png'), optimize=True)

    # The website.
    os.makedirs(os.path.join(SITE, 'brand'), exist_ok=True)
    fit(lock, 1600).save(os.path.join(SITE, 'brand', 'minemuster-logo.webp'), 'WEBP', quality=86, method=6)
    fit(lock, 1200).save(os.path.join(SITE, 'brand', 'minemuster-logo-1200.webp'), 'WEBP', quality=87, method=6)
    fit(lock, 800).save(os.path.join(SITE, 'brand', 'minemuster-logo-800.webp'), 'WEBP', quality=88, method=6)
    site_header_mark().save(os.path.join(SITE, 'brand', 'minemuster-mark-header.webp'), 'WEBP', quality=90, method=6)
    card = Image.new('RGBA', (1200, 630), (0, 0, 0, 255))
    shown = fit(lock, 860)
    card.alpha_composite(shown, ((1200 - shown.width) // 2, (630 - shown.height) // 2))
    card.convert('RGB').save(os.path.join(SITE, 'brand', 'og-image.png'), optimize=True)
    whole_mark((1024, 1024), 820).resize((180, 180), Image.LANCZOS).save(os.path.join(SITE, 'apple-touch-icon.png'), optimize=True)
    favicon.save(os.path.join(SITE, 'favicon.png'), optimize=True)


if __name__ == '__main__':
    main()
