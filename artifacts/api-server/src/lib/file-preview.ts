import { spawn } from "child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "./logger";
import type { FileFormat, GeneratedFile } from "./file-generation";

export interface PreviewOptions {
  /** Maximum number of pages/slides to render. */
  maxPages?: number;
}

let cachedToolsAvailable: boolean | null = null;

function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim() || "(no stderr)"}`));
      }
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [command], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Check whether the external tools required for visual preview are available.
 * The result is cached after the first call.
 */
export async function arePreviewToolsAvailable(): Promise<boolean> {
  if (cachedToolsAvailable != null) return cachedToolsAvailable;
  const [libreoffice, pdftocairo] = await Promise.all([
    commandExists("libreoffice"),
    commandExists("pdftocairo"),
  ]);
  cachedToolsAvailable = libreoffice && pdftocairo;
  if (!cachedToolsAvailable) {
    logger.warn("Preview tools missing: libreoffice and/or pdftocairo not found");
  }
  return cachedToolsAvailable;
}

export async function convertToPdf(
  format: FileFormat,
  buffer: Buffer,
  workDir: string,
): Promise<Buffer> {
  if (format === "pdf") return buffer;

  const inputName = `input.${format}`;
  const inputPath = join(workDir, inputName);
  await writeFile(inputPath, buffer);

  await runCommand(
    "libreoffice",
    ["--headless", "--convert-to", "pdf", "--outdir", workDir, inputPath],
    workDir,
  );

  const outputName = `input.pdf`;
  const outputPath = join(workDir, outputName);
  return readFile(outputPath);
}

export async function renderPdfToImages(
  pdfBuffer: Buffer,
  workDir: string,
  options: PreviewOptions = {},
): Promise<Buffer[]> {
  const maxPages = options.maxPages ?? 3;
  const inputPath = join(workDir, "preview.pdf");
  const outputPrefix = join(workDir, "page");
  await writeFile(inputPath, pdfBuffer);

  await runCommand("pdftocairo", [
    "-png",
    "-f",
    "1",
    "-l",
    String(maxPages),
    inputPath,
    outputPrefix,
  ]);

  const entries = await readdir(workDir);
  const imageNames = entries
    .filter((name) => name.startsWith("page-") && name.endsWith(".png"))
    .sort();

  const images = await Promise.all(
    imageNames.map((name) => readFile(join(workDir, name))),
  );

  if (images.length === 0) {
    throw new Error("pdftocairo produced no images");
  }
  return images;
}

/**
 * Render a generated file to preview images.
 *
 * - PDF is rendered directly.
 * - docx/xlsx/pptx are first converted to PDF via LibreOffice, then rendered.
 * - The caller receives PNG buffers; no files are left behind.
 */
export async function previewGeneratedFile(
  file: GeneratedFile,
  options?: PreviewOptions,
): Promise<Buffer[]> {
  const workDir = await mkdtemp(join(tmpdir(), "chat-preview-"));
  try {
    const pdf = await convertToPdf(file.format, file.buffer, workDir);
    return await renderPdfToImages(pdf, workDir, options);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
