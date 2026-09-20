import { describe, expect, it } from "vitest";
import { cleanFileName, contentTypeFor, extensionOf, isAllowedName, sniffFamily } from "../../src/worker/files/validate";

// 文字列は UTF-8 に直して並べる（charCodeAt だと日本語が下位 8 ビットに潰れて制御文字になる）
const enc = new TextEncoder();
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...enc.encode(p)] : p)));

const PDF = bytes("%PDF-1.7");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], [0x14, 0x00, 0x06, 0x00]);
const OLE2 = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TEXT = bytes("id,name\n1,A社\n");
const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("先頭バイトの大分類", () => {
  it("PDF・zip・OLE2・テキストを見分ける", () => {
    expect(sniffFamily(PDF)).toBe("pdf");
    expect(sniffFamily(ZIP)).toBe("zip");
    expect(sniffFamily(OLE2)).toBe("ole2");
    expect(sniffFamily(TEXT)).toBe("text");
  });

  it("制御文字が混じるもの・空のものはテキストにしない", () => {
    expect(sniffFamily(PNG)).toBeNull();
    expect(sniffFamily(JPEG)).toBeNull();
    expect(sniffFamily(new Uint8Array(0))).toBeNull();
    // 先頭が途中で切れた zip（制御文字が残る）は zip にもテキストにもしない
    expect(sniffFamily(bytes([0x50, 0x4b, 0x03]))).toBeNull();
  });
});

describe("拡張子", () => {
  it("小文字にして返す。無い・先頭だけ・末尾がドットなら空", () => {
    expect(extensionOf("見積書.PDF")).toBe("pdf");
    expect(extensionOf("a.b.xlsx")).toBe("xlsx");
    expect(extensionOf("見積書")).toBe("");
    expect(extensionOf(".pdf")).toBe("");
    expect(extensionOf("見積書.")).toBe("");
  });

  it("許可した 10 種だけ通す", () => {
    for (const ext of ["pdf", "docx", "xlsx", "pptx", "zip", "doc", "xls", "ppt", "csv", "txt"]) {
      expect(isAllowedName(`資料.${ext}`)).toBe(true);
    }
    expect(isAllowedName("run.exe")).toBe(false);
    expect(isAllowedName("page.html")).toBe(false);
    expect(isAllowedName("写真.jpg")).toBe(false);
    expect(isAllowedName("見積書")).toBe(false);
  });
});

describe("拡張子と中身の組み合わせ", () => {
  it("合っていれば Content-Type を返す", () => {
    expect(contentTypeFor("見積書.pdf", PDF)).toBe("application/pdf");
    expect(contentTypeFor("一覧.XLSX", ZIP)).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(contentTypeFor("仕様.docx", ZIP)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(contentTypeFor("資料.zip", ZIP)).toBe("application/zip");
    expect(contentTypeFor("旧.xls", OLE2)).toBe("application/vnd.ms-excel");
    expect(contentTypeFor("data.csv", TEXT)).toBe("text/csv");
    expect(contentTypeFor("memo.txt", TEXT)).toBe("text/plain");
  });

  it("拡張子が無い・許可外・中身と合わないものは null", () => {
    expect(contentTypeFor("見積書", PDF)).toBeNull();
    expect(contentTypeFor(".pdf", PDF)).toBeNull();
    expect(contentTypeFor("run.exe", PDF)).toBeNull();
    expect(contentTypeFor("見積書.pdf", ZIP)).toBeNull();
    expect(contentTypeFor("data.csv", PDF)).toBeNull();
    expect(contentTypeFor("memo.txt", PNG)).toBeNull();
  });
});

describe("ファイル名の整え", () => {
  it("パス区切りと制御文字を落とす", () => {
    expect(cleanFileName("見積書.pdf")).toBe("見積書.pdf");
    expect(cleanFileName("../../etc/passwd.txt")).toBe("....etcpasswd.txt");
    expect(cleanFileName('a"b.txt')).toBe("ab.txt");
    expect(cleanFileName("  前後.pdf  ")).toBe("前後.pdf");
  });

  it("無い・空になる・255 文字を超えるものは null", () => {
    expect(cleanFileName(undefined)).toBeNull();
    expect(cleanFileName("")).toBeNull();
    expect(cleanFileName("   ")).toBeNull();
    expect(cleanFileName(`${"あ".repeat(300)}.pdf`)).toBeNull();
    expect(cleanFileName(`${"あ".repeat(251)}.pdf`)).toHaveLength(255);
  });
});
