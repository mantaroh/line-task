// 添付ファイルの見た目まわり。上限は worker 側（src/worker/files/validate.ts）と同じ値にそろえる。
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "zip", "doc", "xls", "ppt", "csv", "txt"];
export const FILE_ACCEPT = EXTENSIONS.map((e) => `.${e}`).join(",");

const ICONS: Record<string, string> = {
  pdf: "📄",
  xlsx: "📊",
  xls: "📊",
  csv: "📊",
  docx: "📝",
  doc: "📝",
  pptx: "📝",
  ppt: "📝",
  zip: "🗜️",
};

function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return "";
  return name.slice(at + 1).toLowerCase();
}

export function fileIcon(name: string): string {
  return ICONS[extensionOf(name)] ?? "📎";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
}

export function fileSizeMessage(bytes: number): string | null {
  return bytes > MAX_FILE_BYTES ? `10MB までです（このファイルは ${formatFileSize(bytes)}）` : null;
}

export function fileFormatMessage(name: string): string | null {
  return EXTENSIONS.includes(extensionOf(name)) ? null : "この形式は付けられません";
}
