import { describe, it, expect } from "vitest";
import {
  detectFileFormat,
  generateFilename,
  inspectFileData,
  parseFileData,
  renderFile,
  type FileFormat,
} from "./file-generation";

const SAMPLE_MARKDOWN = `
# Report

This is a summary.

## Details

- Point one
- Point two
`;

const SAMPLE_FILE_DATA = {
  title: "Q3 Report",
  content: SAMPLE_MARKDOWN,
};

function wrapFileData(data: unknown): string {
  return `<file_data>\n${JSON.stringify(data)}\n</file_data>`;
}

describe("detectFileFormat", () => {
  it("returns explicit format when provided", () => {
    expect(detectFileFormat("hello", "xlsx")).toBe("xlsx");
    expect(detectFileFormat("hello", "pptx")).toBe("pptx");
  });

  it("detects PDF from text", () => {
    expect(detectFileFormat("レポートをPDFで作成して")).toBe("pdf");
  });

  it("detects Word from text", () => {
    expect(detectFileFormat("Word文書にまとめて")).toBe("docx");
  });

  it("detects Excel from text", () => {
    expect(detectFileFormat("エクセルで表を作って")).toBe("xlsx");
  });

  it("detects PowerPoint from text", () => {
    expect(detectFileFormat("パワーポイントのスライドを作って")).toBe("pptx");
  });

  it("returns null when no format is detected", () => {
    expect(detectFileFormat("こんにちは")).toBeNull();
  });
});

describe("generateFilename", () => {
  it("includes the correct extension", () => {
    expect(generateFilename("pdf", "My Report")).toBe("My Report.pdf");
    expect(generateFilename("xlsx", "Data")).toBe("Data.xlsx");
  });

  it("sanitizes unsafe characters", () => {
    expect(generateFilename("docx", "My: Report?")).toBe("My_ Report_.docx");
  });

  it("uses a default when title is empty", () => {
    expect(generateFilename("pptx")).toMatch(/\.pptx$/);
  });
});

describe("parseFileData", () => {
  it("parses a valid <file_data> block", () => {
    const parsed = parseFileData(wrapFileData(SAMPLE_FILE_DATA));
    expect(parsed).toEqual(SAMPLE_FILE_DATA);
  });

  it("returns null when no block is present", () => {
    expect(parseFileData("no block here")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseFileData("<file_data>not json</file_data>")).toBeNull();
  });

  it("reports safe parse statuses without exposing model output", () => {
    expect(inspectFileData("no block here").status).toBe("missing-file-data");
    expect(inspectFileData("<file_data>not json</file_data>").status).toBe(
      "invalid-json",
    );
    expect(inspectFileData("<file_data>[]</file_data>").status).toBe(
      "invalid-shape",
    );
  });

  it("ignores malformed fields while preserving usable content", () => {
    const inspected = inspectFileData(
      wrapFileData({
        title: { unexpected: true },
        content: "# Valid content",
        sheets: "not-an-array",
      }),
    );
    expect(inspected.status).toBe("parsed");
    expect(inspected.data).toEqual({ content: "# Valid content" });
    expect(inspected.ignoredFields).toEqual(["title", "sheets"]);
  });
});

describe("renderFile", () => {
  const formats: FileFormat[] = ["pdf", "docx", "xlsx", "pptx"];

  for (const format of formats) {
    it(`renders a non-empty ${format.toUpperCase()} buffer`, async () => {
      const file = await renderFile(format, wrapFileData(SAMPLE_FILE_DATA));
      expect(file.buffer.length).toBeGreaterThan(100);
      expect(file.mimeType).toMatch(/application\//);
      expect(file.filename.endsWith(`.${format}`)).toBe(true);
      expect(file.size).toBe(file.buffer.length);
    });
  }

  it("renders an Excel file from structured sheet data", async () => {
    const data = {
      title: "Sales",
      sheets: [
        {
          name: "Q3",
          headers: ["Product", "Revenue"],
          rows: [
            ["A", 1000],
            ["B", 2000],
          ],
        },
      ],
    };
    const file = await renderFile("xlsx", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
  });

  it("renders a PowerPoint file from structured slide data", async () => {
    const data = {
      title: "Pitch",
      slides: [
        {
          title: "Problem",
          bullets: ["Hard to track", "Manual work"],
        },
        {
          title: "Solution",
          bullets: ["Automation", "Insights"],
        },
      ],
    };
    const file = await renderFile("pptx", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
  });

  it("falls back gracefully when file data is missing", async () => {
    const file = await renderFile("pdf", "Plain text without file_data block");
    expect(file.buffer.length).toBeGreaterThan(100);
  });

  it("renders safely when structured fields have malformed nested values", async () => {
    const file = await renderFile(
      "xlsx",
      wrapFileData({
        title: 42,
        sheets: [
          {
            name: { invalid: true },
            headers: ["Valid", { invalid: true }],
            rows: [["value", { invalid: true }], "not-a-row"],
          },
        ],
      }),
    );
    expect(file.buffer.length).toBeGreaterThan(100);
    expect(file.filename).toMatch(/\.xlsx$/);
  });

  it("preserves previous data when the new output is incomplete", async () => {
    const previous = {
      title: "Original Title",
      content: "# Original\n\nBody",
    };
    const update = '<file_data>\n{"content": "# Updated"}\n</file_data>';
    const file = await renderFile("pdf", update, { previousData: previous });
    expect(file.filename).toMatch(/^Original Title/);
  });

  it("includes format in the generated file metadata", async () => {
    const file = await renderFile("docx", wrapFileData(SAMPLE_FILE_DATA));
    expect(file.format).toBe("docx");
  });

  it("renders a Japanese PDF without WinAnsi encoding errors", async () => {
    const data = {
      title: "検索結果まとめ",
      content: "# 検索結果\n\nこれは日本語のPDF生成テストです。\n\n- ポイント1\n- ポイント2",
    };
    const file = await renderFile("pdf", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
    expect(file.filename).toMatch(/\.pdf$/);
  });

  it("renders a Japanese DOCX", async () => {
    const data = {
      title: "検索結果",
      content: "# 検索結果\n\nこれは日本語のDOCX生成テストです。\n\n- ポイント1",
    };
    const file = await renderFile("docx", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
    expect(file.filename).toMatch(/\.docx$/);
  });

  it("renders a Japanese XLSX", async () => {
    const data = {
      title: "検索結果",
      sheets: [
        {
          name: "Sheet1",
          headers: ["項目", "内容"],
          rows: [
            ["項目1", "日本語の内容"],
            ["項目2", "その他の内容"],
          ],
        },
      ],
    };
    const file = await renderFile("xlsx", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
    expect(file.filename).toMatch(/\.xlsx$/);
  });

  it("renders a Japanese PPTX", async () => {
    const data = {
      title: "検索結果",
      slides: [
        {
          title: "スライド1",
          bullets: ["日本語のポイント1", "日本語のポイント2"],
        },
      ],
    };
    const file = await renderFile("pptx", wrapFileData(data));
    expect(file.buffer.length).toBeGreaterThan(100);
    expect(file.filename).toMatch(/\.pptx$/);
  });
});
