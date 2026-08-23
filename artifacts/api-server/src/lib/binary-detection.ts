/**
 * Magic-number based detection for binary attachments. Content, never the
 * client-claimed MIME type, decides what a file is treated as.
 */

export type BinaryFamily = "pdf" | "zip" | "docx" | "xlsx" | "pptx" | "audio";

export interface ZipDirectoryEntry {
  name: string;
  uncompressedSize: number;
}

export interface ZipDirectoryInfo {
  entries: ZipDirectoryEntry[];
  totalUncompressedBytes: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
// EOCD is 22 bytes; the trailing comment may add up to 65535 bytes.
const ZIP_EOCD_MAX_SCAN = 22 + 65535;
const ZIP_MAX_DIRECTORY_ENTRIES = 100_000;

/** Legacy OLE2 container (.doc/.xls/.ppt). Parsing these old binary formats
 * is deliberately out of scope — they are rejected with a conversion hint. */
export function isLegacyOleFile(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  );
}

function decodeZipEntryName(raw: Buffer, flags: number): string {
  // General purpose flag bit 11 marks the name as UTF-8. Other encodings
  // (e.g. Shift-JIS on old Japanese tools) are only approximated.
  const utf8 = (flags & 0x800) !== 0;
  try {
    const decoder = new TextDecoder(utf8 ? "utf-8" : "windows-1252", { fatal: false });
    return decoder.decode(raw).replace(/[\u0000-\u001f]/g, "");
  } catch {
    return raw.toString("latin1").replace(/[\u0000-\u001f]/g, "");
  }
}

/**
 * Reads the zip central directory WITHOUT decompressing anything. Used both to
 * classify zip-family files and to pre-flight zip-bomb budgets: declared
 * uncompressed totals are checked before a single byte is inflated, and a
 * streaming counter enforces the same budget against actual data (headers
 * can lie).
 */
export function readZipCentralDirectory(buffer: Buffer): ZipDirectoryInfo {
  if (buffer.length < 22) {
    throw new ZipFormatError("ZIPファイルが壊れています。");
  }
  const scanStart = Math.max(0, buffer.length - ZIP_EOCD_MAX_SCAN);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ZipFormatError("ZIPファイルの目録が見つかりません。");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directorySize = buffer.readUInt32LE(eocdOffset + 12);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipFormatError("ZIP64形式のアーカイブには対応していません。");
  }
  if (entryCount > ZIP_MAX_DIRECTORY_ENTRIES) {
    throw new ZipFormatError("ZIPファイルのエントリ数が多すぎます。");
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new ZipFormatError("ZIPファイルの目録が壊れています。");
  }

  const entries: ZipDirectoryEntry[] = [];
  let totalUncompressedBytes = 0;
  let offset = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_ENTRY_SIGNATURE) {
      throw new ZipFormatError("ZIPファイルの目録が壊れています。");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (uncompressedSize === 0xffffffff) {
      throw new ZipFormatError("ZIP64形式のアーカイブには対応していません。");
    }
    if (offset + 46 + nameLength > buffer.length) {
      throw new ZipFormatError("ZIPファイルの目録が壊れています。");
    }
    const name = decodeZipEntryName(buffer.subarray(offset + 46, offset + 46 + nameLength), flags);
    entries.push({ name, uncompressedSize });
    totalUncompressedBytes += uncompressedSize;
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, totalUncompressedBytes };
}

/** Office Open XML files are zips with well-known internal entry names. */
export function classifyZipByEntryNames(names: readonly string[]): "docx" | "xlsx" | "pptx" | "zip" {
  const set = new Set(names);
  if (set.has("word/document.xml")) return "docx";
  if (set.has("xl/workbook.xml")) return "xlsx";
  if (set.has("ppt/presentation.xml")) return "pptx";
  return "zip";
}

function hasZipSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  );
}

function looksLikeAudio(buffer: Buffer): boolean {
  const length = buffer.length;
  if (length >= 3 && buffer.subarray(0, 3).toString("latin1") === "ID3") return true; // mp3 with ID3 tag
  if (length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true; // MPEG/ADTS frame sync
  if (
    length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WAVE"
  ) {
    return true;
  }
  if (length >= 4 && buffer.subarray(0, 4).toString("latin1") === "OggS") return true;
  if (length >= 4 && buffer.subarray(0, 4).toString("latin1") === "fLaC") return true;
  if (length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp") return true; // mp4/m4a container
  if (length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true; // webm/matroska (EBML)
  }
  return false;
}

export function detectBinaryFamily(buffer: Buffer): BinaryFamily | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "pdf";
  }
  if (hasZipSignature(buffer)) {
    try {
      const directory = readZipCentralDirectory(buffer);
      return classifyZipByEntryNames(directory.entries.map((entry) => entry.name));
    } catch (err) {
      if (err instanceof ZipFormatError) return null;
      throw err;
    }
  }
  if (looksLikeAudio(buffer)) return "audio";
  return null;
}
