export interface GeneratedAsset {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

export function validateGeneratedAsset(asset: GeneratedAsset): void {
  if (
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.buffer.length !== asset.size
  ) {
    throw new Error("Generated asset metadata does not match its buffer");
  }
  if (!asset.filename.trim())
    throw new Error("Generated asset filename is empty");
  if (!asset.mimeType.trim())
    throw new Error("Generated asset MIME type is empty");
}
