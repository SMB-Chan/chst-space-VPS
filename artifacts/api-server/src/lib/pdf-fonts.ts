import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { StandardFonts } from "pdf-lib";

/**
 * Bundled fallback font shipped with the API server so deployments without a
 * standalone system CJK font can still render Japanese PDFs. In the esbuild
 * bundle __dirname is dist/, while under vitest it is src/lib — cover both.
 */
const BUNDLED_CJK_FONT_CANDIDATES =
  typeof __dirname === "string"
    ? [
        path.join(__dirname, "fonts", "IPAGothic.ttf"),
        path.join(__dirname, "..", "..", "fonts", "IPAGothic.ttf"),
      ]
    : [];

/**
 * Candidate system fonts that support CJK (Chinese, Japanese, Korean) characters.
 * The bundled font comes first: some system "CJK fallback" fonts (e.g. the
 * Droid Sans Fallback build shipped for server images) contain no Latin/digit
 * glyphs at all, which turns every number in a PDF into a tofu box.
 */
const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "C:\\Windows\\Fonts\\msgothic.ttc",
  "C:\\Windows\\Fonts\\YuGothM.ttc",
  "C:\\Windows\\Fonts\\msyh.ttc",
].filter((p): p is string => typeof p === "string");

let fontkitModule: unknown | undefined;
let cachedCjkFontBytes: Buffer | null | undefined;
let cachedCjkFontPath: string | null | undefined;

export class CjkFontUnavailableError extends Error {
  readonly code = "CJK_FONT_UNAVAILABLE";

  constructor() {
    super(
      "Japanese PDF content requires a usable CJK font, but none was found",
    );
    this.name = "CjkFontUnavailableError";
  }
}

export function hasCjkText(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function isStandaloneFontFile(fontPath: string): boolean {
  return /\.(?:ttf|otf)$/i.test(fontPath) && !/\.ttc$/i.test(fontPath);
}

function discoverFontconfigCandidates(): string[] {
  try {
    const output = execFileSync("fc-list", ["-f", "%{file}\n", ":lang=ja"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (fontPath, index, paths) =>
          Boolean(fontPath) &&
          isStandaloneFontFile(fontPath) &&
          existsSync(fontPath) &&
          paths.indexOf(fontPath) === index,
      );
  } catch {
    return [];
  }
}

function getCjkFontCandidates(): string[] {
  const candidates = [
    ...BUNDLED_CJK_FONT_CANDIDATES,
    ...discoverFontconfigCandidates(),
    ...CJK_FONT_CANDIDATES.filter(isStandaloneFontFile),
  ];
  return candidates.filter(
    (fontPath, index) => candidates.indexOf(fontPath) === index,
  );
}

/** Load CJK font bytes from the first available system or fontconfig font. */
export function loadCjkFontBytes(): Buffer | undefined {
  if (cachedCjkFontBytes !== undefined) {
    return cachedCjkFontBytes || undefined;
  }
  for (const fontPath of getCjkFontCandidates()) {
    if (existsSync(fontPath)) {
      try {
        cachedCjkFontBytes = readFileSync(fontPath);
        cachedCjkFontPath = fontPath;
        return cachedCjkFontBytes;
      } catch {
        // Continue to next candidate.
      }
    }
  }
  cachedCjkFontBytes = null;
  cachedCjkFontPath = null;
  return undefined;
}

export function getCjkFontStatus(): {
  available: boolean;
  fontPath?: string;
} {
  const available = Boolean(loadCjkFontBytes());
  return {
    available,
    fontPath: available ? cachedCjkFontPath || undefined : undefined,
  };
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
      // Subset embedding keeps Japanese PDFs small. This requires a complete
      // font: the previously bundled Droid Sans Fallback build lacked Latin
      // glyphs, which both broke subsetting (katakana tofu) and dropped every
      // digit. The bundled IPA Gothic covers ASCII + CJK and subsets cleanly.
      const regular = await pdfDoc.embedFont(bytes, { subset: true });
      // Most candidate sets only ship a regular face; reuse it for bold and rely on size contrast.
      return { regular, bold: regular };
    }
    throw new CjkFontUnavailableError();
  }

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold };
}
