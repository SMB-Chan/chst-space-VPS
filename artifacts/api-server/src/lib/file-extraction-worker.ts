import { parentPort } from "node:worker_threads";
import {
  extractDocxText,
  extractPdfText,
  extractPptxText,
  extractXlsxText,
  extractZipText,
  FileExtractionError,
} from "./file-extraction";
import type { BinaryFamily } from "./binary-detection";

type WorkerRequest = {
  family: Exclude<BinaryFamily, "audio">;
  buffer: Uint8Array;
};

if (!parentPort) {
  throw new Error("Attachment extraction worker requires parentPort");
}

parentPort.on("message", async (request: WorkerRequest) => {
  try {
    const attachment = Buffer.from(request.buffer);
    let text: string;
    switch (request.family) {
      case "pdf":
        text = await extractPdfText(attachment);
        break;
      case "docx":
        text = await extractDocxText(attachment);
        break;
      case "xlsx":
        text = extractXlsxText(attachment);
        break;
      case "pptx":
        text = extractPptxText(attachment);
        break;
      case "zip":
        text = extractZipText(attachment);
        break;
      default: {
        const exhaustive: never = request.family;
        throw new Error(
          `Unsupported isolated attachment family: ${String(exhaustive)}`,
        );
      }
    }
    parentPort?.postMessage({ ok: true, text });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      message:
        error instanceof FileExtractionError
          ? error.publicMessage
          : "添付ファイルの解析に失敗しました。ファイルが破損している可能性があります。",
    });
  }
});
