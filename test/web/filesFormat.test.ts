import { describe, expect, it } from "vitest";
import {
  FILE_ACCEPT,
  fileFormatMessage,
  fileIcon,
  fileSizeMessage,
  formatFileSize,
} from "../../src/web/files/format";

describe("添付ファイルの表示", () => {
  it("拡張子でアイコンを決める", () => {
    expect(fileIcon("見積書.pdf")).toBe("📄");
    expect(fileIcon("一覧.XLSX")).toBe("📊");
    expect(fileIcon("data.csv")).toBe("📊");
    expect(fileIcon("仕様.docx")).toBe("📝");
    expect(fileIcon("資料.zip")).toBe("🗜️");
    expect(fileIcon("memo.txt")).toBe("📎");
  });

  it("1MB 未満は KB で出す", () => {
    expect(formatFileSize(512)).toBe("1KB");
    expect(formatFileSize(3 * 1024)).toBe("3KB");
    expect(formatFileSize(1024 * 1024)).toBe("1MB");
    expect(formatFileSize(2.35 * 1024 * 1024)).toBe("2.4MB");
  });

  it("上限を超えたときだけ文言を返す", () => {
    expect(fileSizeMessage(1024)).toBeNull();
    expect(fileSizeMessage(10 * 1024 * 1024)).toBeNull();
    expect(fileSizeMessage(11 * 1024 * 1024)).toBe("10MB までです（このファイルは 11MB）");
  });

  it("許可外の拡張子のときだけ文言を返す", () => {
    expect(fileFormatMessage("見積書.pdf")).toBeNull();
    expect(fileFormatMessage("run.exe")).toBe("この形式は付けられません");
    expect(fileFormatMessage("見積書")).toBe("この形式は付けられません");
  });

  it("accept には許可した拡張子が並ぶ", () => {
    expect(FILE_ACCEPT.split(",")).toContain(".xlsx");
    expect(FILE_ACCEPT.split(",")).not.toContain(".exe");
  });
});
