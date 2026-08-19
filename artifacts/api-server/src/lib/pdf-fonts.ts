import { existsSync, readFileSync } from "node:fs";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { StandardFonts } from "pdf-lib";

/**
 * Candidate system fonts that support CJK (Chinese, Japanese, Korean) characters.
 * Ordered by preference: smaller fonts first, then common OS defaults.
 */
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "C:\\Windows\\Fonts\\msgothic.ttc",
  "C:\\Windows\\Fonts\\YuGothM.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
];

let fontkitModule: unknown | undefined;
let cachedCjkFontBytes: Buffer | null | undefined;

export function hasCjkText(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

/** Load CJK font bytes from the first available system font. */
export function loadCjkFontBytes(): Buffer | undefined {
  if (cachedCjkFontBytes !== undefined) {
    return cachedCjkFontBytes || undefined;
  }
  for (const fontPath of CJK_FONT_CANDIDATES) {
    if (existsSync(fontPath)) {
      try {
        cachedCjkFontBytes = readFileSync(fontPath);
        return cachedCjkFontBytes;
      } catch {
        // Continue to next candidate.
      }
    }
  }
  cachedCjkFontBytes = null;
  return undefined;
}

async function getFontkitInstance(): Promise<unknown> {
  if (!fontkitModule) {
    const mod = await import("@pdf-lib/fontkit");
    // @pdf-lib/fontkit exports the fontkit object as default at runtime, but its
    // types use `export as namespace`. Use default when present, otherwise the namespace.
    fontkitModule = (mod as unknown as { default?: unknown }).default ?? mod;
  }
  return fontkitModule;
}

/**
 * Embed a font suitable for the given text.
 * Falls back to the standard Helvetica font for Latin-only text so PDFs stay small.
 * For CJK text, embeds a system CJK font with subsetting.
 */
export async function embedFontForText(
  pdfDoc: PDFDocument,
  text: string,
): Promise<{ regular: PDFFont; bold: PDFFont }> {
  if (hasCjkText(text)) {
    const bytes = loadCjkFontBytes();
    if (bytes) {
      const fontkit = await getFontkitInstance();
      pdfDoc.registerFontkit(fontkit as never);
      const regular = await pdfDoc.embedFont(bytes, { subset: true });
      // Most candidate sets only ship a regular face; reuse it for bold and rely on size contrast.
      return { regular, bold: regular };
    }
  }

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold };
}
