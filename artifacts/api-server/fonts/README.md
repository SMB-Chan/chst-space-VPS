# Bundled CJK Font

This directory contains a fallback CJK font used when the host system does not
provide a usable standalone TrueType/OpenType font for Japanese PDF rendering.

## DroidSansFallbackFull.ttf

- Source: Android Open Source Project (AOSP)
- License: Apache License 2.0
- Provides coverage for CJK characters used in generated PDFs.

The font is bundled so that PDF generation works reliably across deployments
that may only ship TrueType Collection (`.ttc`) fonts, which `pdf-lib` cannot
embed directly.
