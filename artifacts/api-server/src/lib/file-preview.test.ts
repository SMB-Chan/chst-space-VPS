import { describe, it, expect, beforeAll } from "vitest";
import { renderFile, type FileFormat } from "./file-generation";
import { arePreviewToolsAvailable, previewGeneratedFile } from "./file-preview";

const SAMPLE_FILE_DATA = {
  title: "Preview Test",
  content: "# Hello\n\nThis is a test document.\n\n- One\n- Two\n",
};

const SAMPLE_SHEET_DATA = {
  title: "Sheet Preview",
  sheets: [
    {
      name: "Data",
      headers: ["A", "B"],
      rows: [[1, 2]],
    },
  ],
};

const SAMPLE_SLIDE_DATA = {
  title: "Slide Preview",
  slides: [
    {
      title: "First Slide",
      bullets: ["Point A", "Point B"],
    },
  ],
};

function wrapFileData(data: unknown): string {
  return `<file_data>\n${JSON.stringify(data)}\n</file_data>`;
}

describe("file-preview", () => {
  let toolsAvailable = false;

  beforeAll(async () => {
    toolsAvailable = await arePreviewToolsAvailable();
  });

  it("reports preview tool availability", async () => {
    const available = await arePreviewToolsAvailable();
    expect(typeof available).toBe("boolean");
  });

  for (const format of ["pdf", "docx", "xlsx", "pptx"] as FileFormat[]) {
    it(`renders ${format.toUpperCase()} preview images when tools are available`, async () => {
      if (!toolsAvailable) {
        return;
      }

      const data =
        format === "xlsx" ? SAMPLE_SHEET_DATA :
        format === "pptx" ? SAMPLE_SLIDE_DATA :
        SAMPLE_FILE_DATA;
      const file = await renderFile(format, wrapFileData(data));
      const images = await previewGeneratedFile(file, { maxPages: 1 });

      expect(images.length).toBeGreaterThan(0);
      for (const image of images) {
        expect(image.length).toBeGreaterThan(100);
        expect(image[0]).toBe(0x89); // PNG magic byte
        expect(image[1]).toBe(0x50);
        expect(image[2]).toBe(0x4e);
        expect(image[3]).toBe(0x47);
      }
    });
  }
});
