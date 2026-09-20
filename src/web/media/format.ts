import type { MediaKind } from "../../shared/types";

export const MAX_MEDIA = 3;
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

const AUDIO_EXT = ["m4a", "mp3", "wav", "ogg", "oga", "opus", "aac"];
const VIDEO_EXT = ["mp4", "m4v", "mov", "webm"];

// ファイル選択で渡された MIME は空のこともあるので、その場合は拡張子で決める
export function mediaKindOf(file: { type: string; name: string }): MediaKind | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!file.name.includes(".")) return null;
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (VIDEO_EXT.includes(ext)) return "video";
  return null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  const mb = Math.round((bytes / 1024 / 1024) * 10) / 10;
  return `${mb}MB`;
}

export function mediaSizeMessage(bytes: number): string | null {
  return bytes > MAX_MEDIA_BYTES ? `30MB までです（このファイルは ${formatBytes(bytes)}）` : null;
}
