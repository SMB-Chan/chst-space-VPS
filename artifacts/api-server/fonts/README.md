# Bundled CJK Font

This directory contains a fallback font used when the host system does not
provide a usable standalone TrueType/OpenType font for Japanese PDF rendering.

## IPAGothic.ttf

- Source: IPA (Information-technology Promotion Agency, Japan) / CITPC,
  via the Debian `fonts-ipafont-gothic` package
- License: IPA Font License v1.0 (see `IPA_Font_License_v1.0.txt`)
- Covers ASCII (letters, digits, symbols) AND Japanese (hiragana, katakana,
  kanji). A CJK-only fallback font is NOT sufficient: the previously bundled
  Droid Sans Fallback build contained no Latin glyphs, so every digit in a
  generated PDF rendered as a tofu box.

The font is bundled so that PDF generation works reliably across deployments
that may only ship TrueType Collection (`.ttc`) fonts, which `pdf-lib` cannot
embed directly.
