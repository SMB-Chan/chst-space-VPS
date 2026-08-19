import { spawn } from "child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "./logger";
import type { FileFormat, GeneratedFile } from "./file-generation";
import { elapsedMs, getFileGenerationErrorDetails } from "./file-diagnostics";

export interface PreviewOptions {
  /** Maximum number of pages/slides to render. */
  maxPages?: number;
  diagnosticContext?: {
    requestId?: string;
    conversationId?: number;
    attempt?: number;
    iteration?: number;
  };
}

export interface PreviewToolStatus {
  libreoffice: boolean;
  pdftocairo: boolean;
  available: boolean;
}

export class ExternalCommandError extends Error {
  readonly command: string;
  readonly commandArgs: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: {
    command: string;
    commandArgs: string[];
    exitCode: number | null;
    stderr?: string;
    cause?: unknown;
  }) {
    const stderr = (args.stderr?.trim() || "(no stderr)").slice(0, 8_000);
    const exitDescription =
      args.exitCode === null ? "failed to start" : `exited with ${args.exitCode}`;
    super(`${args.command} ${exitDescription}: ${stderr}`, {
      cause: args.cause,
    });
    this.name = "ExternalCommandError";
    this.command = args.command;
    this.commandArgs = [...args.commandArgs];
    this.exitCode = args.exitCode;
    this.stderr = stderr;
  }
}

let cachedToolStatus: PreviewToolStatus | null = null;

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_STDERR_CHARS = 64 * 1024;

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      // These tools communicate through files. Ignoring stdout avoids a child
      // process deadlock if it unexpectedly writes more than the pipe buffer.
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
    });

    let stderr = "";
    let killedByTimeout = false;

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_COMMAND_STDERR_CHARS) return;
      const remaining = MAX_COMMAND_STDERR_CHARS - stderr.length;
      stderr += chunk.toString("utf8").slice(0, remaining);
    });

    proc.on("error", (err) => {
      reject(
        new ExternalCommandError({
          command,
          commandArgs: args,
          exitCode: null,
          stderr: err.message,
          cause: err,
        }),
      );
    });

    // If the process is still alive after the spawn timeout, force-kill it.
    const hardKill = setTimeout(() => {
      killedByTimeout = true;
      proc.kill("SIGKILL");
    }, timeoutMs + 5_000);

    proc.on("close", (code, signal) => {
      clearTimeout(hardKill);
      if (code === 0) {
        resolve();
      } else if (killedByTimeout || signal) {
        reject(
          new ExternalCommandError({
            command,
            commandArgs: args,
            exitCode: null,
            stderr: `Command timed out after ${timeoutMs}ms (signal: ${signal ?? "SIGTERM"})\n${stderr}`,
          }),
        );
      } else {
        reject(
          new ExternalCommandError({
            command,
            commandArgs: args,
            exitCode: code,
            stderr,
          }),
        );
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
  return (await getPreviewToolStatus()).available;
}

export async function getPreviewToolStatus(): Promise<PreviewToolStatus> {
  if (cachedToolStatus) return cachedToolStatus;
  const [libreoffice, pdftocairo] = await Promise.all([
    commandExists("libreoffice"),
    commandExists("pdftocairo"),
  ]);
  cachedToolStatus = {
    libreoffice,
    pdftocairo,
    available: libreoffice && pdftocairo,
  };
  if (!cachedToolStatus.available) {
    logger.warn(
      {
        stage: "layout-preview-prerequisites",
        libreoffice,
        pdftocairo,
      },
      "File layout preview prerequisites are unavailable",
    );
  }
  return cachedToolStatus;
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
  let stage =
    file.format === "pdf"
      ? "layout-preview-pdf-render"
      : "layout-preview-office-conversion";
  let stageStartedAt = Date.now();
  const diagnosticContext = {
    ...options?.diagnosticContext,
    fileFormat: file.format,
  };
  try {
    let pdf: Buffer;
    if (file.format === "pdf") {
      pdf = file.buffer;
    } else {
      logger.info(
        { ...diagnosticContext, stage },
        "File layout preview Office conversion started",
      );
      pdf = await convertToPdf(file.format, file.buffer, workDir);
      logger.info(
        {
          ...diagnosticContext,
          stage,
          elapsedMs: elapsedMs(stageStartedAt),
        },
        "File layout preview Office conversion completed",
      );
    }

    stage = "layout-preview-pdf-render";
    stageStartedAt = Date.now();
    logger.info(
      { ...diagnosticContext, stage },
      "File layout preview PDF rendering started",
    );
    const images = await renderPdfToImages(pdf, workDir, options);
    logger.info(
      {
        ...diagnosticContext,
        stage,
        elapsedMs: elapsedMs(stageStartedAt),
        imageCount: images.length,
      },
      "File layout preview PDF rendering completed",
    );
    return images;
  } catch (error) {
    logger.warn(
      {
        ...diagnosticContext,
        stage,
        elapsedMs: elapsedMs(stageStartedAt),
        error: getFileGenerationErrorDetails(error),
      },
      "File layout preview stage failed",
    );
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
