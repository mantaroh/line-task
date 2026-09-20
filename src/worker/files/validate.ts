// タスクに付けるファイルの形式を、先頭のバイトと拡張子の両方で決める。画面から送られた Content-Type は使わない。
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;
// テキストかどうかは先頭 512 バイトで決める。ほかの大分類は 8 バイトあれば足りる
export const SNIFF_BYTES = 512;
export const MAX_NAME_LENGTH = 255;

export type FileFamily = "pdf" | "zip" | "ole2" | "text";

const OOXML = "application/vnd.openxmlformats-officedocument";
const BY_EXT: Record<string, { family: FileFamily; contentType: string }> = {
  pdf: { family: "pdf", contentType: "application/pdf" },
  docx: { family: "zip", contentType: `${OOXML}.wordprocessingml.document` },
  xlsx: { family: "zip", contentType: `${OOXML}.spreadsheetml.sheet` },
  pptx: { family: "zip", contentType: `${OOXML}.presentationml.presentation` },
  zip: { family: "zip", contentType: "application/zip" },
  doc: { family: "ole2", contentType: "application/msword" },
  xls: { family: "ole2", contentType: "application/vnd.ms-excel" },
  ppt: { family: "ole2", contentType: "application/vnd.ms-powerpoint" },
  csv: { family: "text", contentType: "text/csv" },
  txt: { family: "text", contentType: "text/plain" },
};

const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04];
const OLE2_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(head: Uint8Array, want: number[]): boolean {
  return head.length >= want.length && want.every((b, i) => head[i] === b);
}

// タブ・改行・復帰だけは通す。それ以外の制御文字があればテキストとして扱わない
function isTextByte(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true;
  return b >= 0x20 && b !== 0x7f;
}

export function sniffFamily(head: Uint8Array): FileFamily | null {
  if (head.length === 0) return null;
  if (startsWith(head, PDF_HEAD)) return "pdf";
  if (startsWith(head, ZIP_HEAD)) return "zip";
  if (startsWith(head, OLE2_HEAD)) return "ole2";
  return head.every(isTextByte) ? "text" : null;
}

export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return "";
  return name.slice(at + 1).toLowerCase();
}

export function isAllowedName(name: string): boolean {
  return BY_EXT[extensionOf(name)] !== undefined;
}

export function contentTypeFor(name: string, head: Uint8Array): string | null {
  const allowed = BY_EXT[extensionOf(name)];
  if (!allowed) return null;
  return sniffFamily(head) === allowed.family ? allowed.contentType : null;
}

export function cleanFileName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && ch !== "/" && ch !== "\\" && ch !== '"';
    })
    .join("")
    .trim();
  if (cleaned === "" || cleaned.length > MAX_NAME_LENGTH) return null;
  return cleaned;
}
