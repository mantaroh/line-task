// 動画・音声の形式を本文の先頭 12 バイトで決める。画面から送られた Content-Type は使わない。
import type { MediaKind } from "../../shared/types";

export const SNIFF_BYTES = 12;

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) return false;
  return true;
}

export function sniffMedia(head: Uint8Array, kind: MediaKind): string | null {
  if (head.length < SNIFF_BYTES) return null;
  // mp4・mov・m4a は同じ入れ物なので、種類で決める
  if (ascii(head, 4, "ftyp")) {
    if (kind === "audio") return "audio/mp4";
    return ascii(head, 8, "qt  ") ? "video/quicktime" : "video/mp4";
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return `${kind}/webm`;
  if (kind !== "audio") return null;
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return "audio/wav";
  if (ascii(head, 0, "OggS")) return "audio/ogg";
  // ADTS（aac）は mp3 のフレームと先頭が似ているので先に見る
  if (head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)) return "audio/aac";
  if (ascii(head, 0, "ID3")) return "audio/mpeg";
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}
