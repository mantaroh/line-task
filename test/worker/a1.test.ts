import { describe, expect, it } from "vitest";
import { colLetter, parseRange, quoteSheet, rangeOf } from "../../src/worker/sheets/a1";

describe("a1", () => {
  it("colLetter", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
  });

  it("quoteSheet はシート名を引用し、' を '' にする", () => {
    expect(quoteSheet("タスク")).toBe("'タスク'");
    expect(quoteSheet("a'b")).toBe("'a''b'");
  });

  it("rangeOf", () => {
    expect(rangeOf("タスク", "A1:Z")).toBe("'タスク'!A1:Z");
  });

  it("parseRange：セル範囲", () => {
    expect(parseRange("'タスク'!B5:D5")).toEqual({
      sheet: "タスク",
      startCol: 1,
      startRow: 4,
      endCol: 3,
      endRow: 4,
    });
  });

  it("parseRange：列範囲（行は null）", () => {
    expect(parseRange("'_設定'!A:A")).toEqual({
      sheet: "_設定",
      startCol: 0,
      startRow: 0,
      endCol: 0,
      endRow: null,
    });
  });

  it("parseRange：終端行なしの範囲", () => {
    expect(parseRange("'タスク'!A1:Z")).toEqual({
      sheet: "タスク",
      startCol: 0,
      startRow: 0,
      endCol: 25,
      endRow: null,
    });
  });

  it("parseRange：行範囲（列は null）", () => {
    expect(parseRange("'タスク'!1:1")).toEqual({
      sheet: "タスク",
      startCol: 0,
      startRow: 0,
      endCol: null,
      endRow: 0,
    });
  });

  it("parseRange：単一セル", () => {
    expect(parseRange("'タスク'!B2")).toEqual({
      sheet: "タスク",
      startCol: 1,
      startRow: 1,
      endCol: 1,
      endRow: 1,
    });
  });

  it("parseRange：シート名の中の '' はリテラルの '", () => {
    expect(parseRange("'a''b'!A1")).toEqual({
      sheet: "a'b",
      startCol: 0,
      startRow: 0,
      endCol: 0,
      endRow: 0,
    });
  });

  it("parseRange：不正な入力は例外", () => {
    expect(() => parseRange("不正な範囲")).toThrow();
    expect(() => parseRange("タスク!A1")).toThrow();
  });
});
