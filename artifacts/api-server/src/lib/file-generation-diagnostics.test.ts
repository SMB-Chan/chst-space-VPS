import { describe, expect, it } from "vitest";
import { renderFile, type FileFormat } from "./file-generation";
import { getPreviewToolStatus } from "./file-preview";
import { getCjkFontStatus } from "./pdf-fonts";

const FORMATS: FileFormat[] = ["pdf", "docx", "xlsx", "pptx"];

function wrapFileData(data: unknown): string {
  return `<file_data>\n${JSON.stringify(data)}\n</file_data>`;
}

describe("file generation runtime diagnostics", () => {
  it("reports preview binaries and a usable CJK font", async () => {
    const preview = await getPreviewToolStatus();
    const cjkFont = getCjkFontStatus();

    console.info(
      `[file-generation-diagnostics] prerequisites=${JSON.stringify({
        libreoffice: preview.libreoffice,
        pdftocairo: preview.pdftocairo,
        cjkFontAvailable: cjkFont.available,
        cjkFontPath: cjkFont.fontPath,
      })}`,
    );

    expect(typeof preview.libreoffice).toBe("boolean");
    expect(typeof preview.pdftocairo).toBe("boolean");
    expect(typeof cjkFont.available).toBe("boolean");
  });

  it("renders all supported formats with representative data", async () => {
    for (const format of FORMATS) {
      const data =
        format === "xlsx"
          ? {
              title: "Diagnostics",
              sheets: [
                {
                  name: "Data",
                  headers: ["Item", "Value"],
                  rows: [["alpha", 1]],
                },
              ],
            }
          : format === "pptx"
            ? {
                title: "Diagnostics",
                slides: [
                  { title: "Result", bullets: ["Generation succeeded"] },
                ],
              }
            : {
                title: "Diagnostics",
                content: "# Result\n\nGeneration succeeded.",
              };
      const file = await renderFile(format, wrapFileData(data));
      console.info(
        `[file-generation-diagnostics] format=${format} bytes=${file.size} status=ok`,
      );
      expect(file.size).toBeGreaterThan(100);
    }
  });

  it("renders Japanese PDF content with an embedded CJK font", async () => {
    const file = await renderFile(
      "pdf",
      wrapFileData({
        title: "日本語PDF診断",
        content: "# 診断結果\n\n日本語のPDF生成に成功しました。",
      }),
    );
    console.info(
      `[file-generation-diagnostics] format=pdf language=ja bytes=${file.size} status=ok`,
    );
    expect(file.size).toBeGreaterThan(100);
  });
});