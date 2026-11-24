#!/usr/bin/env python3
"""Makes the WOFF2 copies of the app's fonts that build-preview.mjs packs into the single-file preview.

The preview has to stay under 2 MB to open in the Claude phone app, and the five fonts were a third
of it. A copy is the same font compressed: every glyph, every feature, nothing left out.

Each copy is named after the hash of the file it was made from, which is how the built app names
that file, so the packer never pairs a copy with a font it was not made from. Run this again when a
font package is updated or the app loads another weight:

    pip install fonttools brotli
    python3 scripts/compress-preview-fonts.py
"""
import hashlib
import pathlib
import re
import shutil

from fontTools.ttLib import TTFont

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "scripts" / "preview-fonts"
out.mkdir(exist_ok=True)
for old in out.glob("*.woff2"):
    old.unlink()

# The fonts the app loads, from its own imports: the package and the weight of each.
fonts = re.findall(r"@expo-google-fonts/([\w-]+)/(\w+)'", (root / "App.tsx").read_text())
for package, weight in fonts:
    source = next((root / "node_modules" / "@expo-google-fonts" / package / weight).glob("*.ttf"))
    digest = hashlib.md5(source.read_bytes()).hexdigest()
    # Keep the font's own dates, so the same font always makes the same copy.
    font = TTFont(source, recalcTimestamp=False)
    font.flavor = "woff2"
    target = out / f"{source.stem}.{digest}.woff2"
    font.save(target)
    print(f"{target.name}: {source.stat().st_size} -> {target.stat().st_size} bytes")

# The fonts are shared under the SIL Open Font License, which asks that it travels with them.
shutil.copyfile(root / "node_modules" / "@expo-google-fonts" / fonts[0][0] / "LICENSE_FONT", out / "OFL.txt")
