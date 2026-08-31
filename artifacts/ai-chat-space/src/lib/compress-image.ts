export const COMPRESS_MIN_BYTES = 400 * 1024;
export const COMPRESS_MAX_EDGE = 1600;
export const COMPRESS_QUALITY = 0.82;

export function shouldCompressImage(file: {
  type: string;
  size: number;
}): boolean {
  if (!file.type.startsWith("image/")) return false;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return false;
  return file.size >= COMPRESS_MIN_BYTES;
}

export function compressedFileName(original: string): string {
  return original.replace(/\.[^.]+$/, "") + ".jpg";
}

export async function compressImageFile(
  file: File,
): Promise<{ file: File; reduced: boolean }> {
  if (!shouldCompressImage(file)) return { file, reduced: false };
  if (typeof createImageBitmap !== "function") return { file, reduced: false };

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file, reduced: false };
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", COMPRESS_QUALITY);
    });
    if (!blob || blob.size >= file.size) return { file, reduced: false };

    return {
      file: new File([blob], compressedFileName(file.name), {
        type: "image/jpeg",
      }),
      reduced: true,
    };
  } finally {
    bitmap.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
