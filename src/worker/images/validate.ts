// 画像の追加で受け取る form の確認。本体・サムネイルとも JPEG だけを受け付ける。
import { HttpError } from "../errors";

export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_THUMB_BYTES = 200 * 1024;
export const MAX_DIMENSION = 1600;

export type UploadInput = { image: ArrayBuffer; thumb: ArrayBuffer; width: number; height: number };

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

const formatError = () => new HttpError(400, "image_format", "JPEG の画像を送ってください");
const sizeError = () => new HttpError(400, "image_size", "画像が大きすぎます");
const dimensionError = () => new HttpError(400, "validation", "画像の大きさが正しくありません");

function jpegFile(value: File | string | null): File {
  if (!(value instanceof File) || value.type !== "image/jpeg") throw formatError();
  return value;
}

// 大きなファイルを丸ごと読む前に、先頭 3 バイトと大きさだけで確かめる
async function checkFile(file: File, maxBytes: number): Promise<void> {
  if (file.size === 0) throw formatError();
  if (!isJpeg(new Uint8Array(await file.slice(0, 3).arrayBuffer()))) throw formatError();
  if (file.size > maxBytes) throw sizeError();
}

function dimension(value: File | string | null): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw dimensionError();
  const n = Number(value);
  if (n < 1 || n > MAX_DIMENSION) throw dimensionError();
  return n;
}

export async function parseUpload(form: FormData): Promise<UploadInput> {
  const imageFile = jpegFile(form.get("image"));
  const thumbFile = jpegFile(form.get("thumb"));
  await checkFile(imageFile, MAX_IMAGE_BYTES);
  await checkFile(thumbFile, MAX_THUMB_BYTES);
  const width = dimension(form.get("width"));
  const height = dimension(form.get("height"));
  const image = await imageFile.arrayBuffer();
  const thumb = await thumbFile.arrayBuffer();
  return { image, thumb, width, height };
}
