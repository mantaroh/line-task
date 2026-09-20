export const FULL_MAX = 1600;
export const THUMB_MAX = 320;

const FULL_BYTES = 2 * 1024 * 1024;
const THUMB_BYTES = 200 * 1024;
const FULL_QUALITY = 0.85;
const FULL_RETRY_QUALITY = 0.7;
const THUMB_QUALITY = 0.7;
const THUMB_RETRY_QUALITY = 0.5;

// 長辺が max 以下ならそのまま。超えれば縦横比を保って長辺を max にする
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class ImageReadError extends Error {
  constructor(message = "この画像は読み込めません") {
    super(message);
    this.name = "ImageReadError";
  }
}

async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageReadError();
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageReadError();
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ImageReadError())),
      "image/jpeg",
      quality,
    );
  });
}

// 決めた品質で作り、上限を超えたら品質を下げて 1 回だけ作り直す
async function encodeWithin(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  quality: number,
  retryQuality: number,
  maxBytes: number,
): Promise<Blob> {
  let blob = await encode(bitmap, size.width, size.height, quality);
  if (blob.size > maxBytes) blob = await encode(bitmap, size.width, size.height, retryQuality);
  if (blob.size > maxBytes) throw new ImageReadError("画像が大きすぎます");
  return blob;
}

export async function prepareImage(file: File): Promise<{ image: Blob; thumb: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    // 既定の設定で、写真の向きの情報に従って回転される
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageReadError();
  }
  try {
    const full = fitWithin(bitmap.width, bitmap.height, FULL_MAX);
    const small = fitWithin(bitmap.width, bitmap.height, THUMB_MAX);
    const image = await encodeWithin(bitmap, full, FULL_QUALITY, FULL_RETRY_QUALITY, FULL_BYTES);
    const thumb = await encodeWithin(bitmap, small, THUMB_QUALITY, THUMB_RETRY_QUALITY, THUMB_BYTES);
    return { image, thumb, width: full.width, height: full.height };
  } finally {
    bitmap.close();
  }
}
