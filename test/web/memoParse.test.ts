import { describe, expect, it } from "vitest";
import { parseInline, parseMemo, safeHref } from "../../src/web/memo/parse";

describe("safeHref", () => {
  it("http・https だけを通す", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("line://ti/p/x")).toBeNull();
    expect(safeHref("example.com")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("parseInline", () => {
  it("文字だけ", () => {
    expect(parseInline("先方の回答待ち")).toEqual([{ type: "text", text: "先方の回答待ち" }]);
  });

  it("URL をリンクにし、後ろの句読点は含めない", () => {
    expect(parseInline("詳細は https://example.com/x。確認")).toEqual([
      { type: "text", text: "詳細は " },
      { type: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { type: "text", text: "。確認" },
    ]);
    expect(parseInline("(https://example.com/a)")).toEqual([
      { type: "text", text: "(" },
      { type: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { type: "text", text: ")" },
    ]);
  });

  it("[名前](URL) をリンクにする。開けない URL は文字のまま", () => {
    expect(parseInline("資料: [設定手順](https://example.com/doc)")).toEqual([
      { type: "text", text: "資料: " },
      { type: "link", text: "設定手順", href: "https://example.com/doc" },
    ]);
    expect(parseInline("[押して](javascript:alert(1))")).toEqual([{ type: "text", text: "[押して](javascript:alert(1))" }]);
  });

  it("**太字** の中のリンクも使える。閉じていない ** は文字のまま", () => {
    expect(parseInline("**来週まで** です")).toEqual([
      { type: "bold", children: [{ type: "text", text: "来週まで" }] },
      { type: "text", text: " です" },
    ]);
    expect(parseInline("**[手順](https://e.com)**")).toEqual([
      { type: "bold", children: [{ type: "link", text: "手順", href: "https://e.com/" }] },
    ]);
    expect(parseInline("2**3 と **途中")).toEqual([{ type: "text", text: "2**3 と **途中" }]);
  });
});

describe("parseMemo", () => {
  it("空なら何も無い", () => {
    expect(parseMemo("")).toEqual([]);
    expect(parseMemo("\n\n")).toEqual([]);
  });

  it("続いた行は 1 つの段落、空行で段落を分ける", () => {
    expect(parseMemo("一行目\r\n二行目\n\n三行目")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "一行目" }], [{ type: "text", text: "二行目" }]] },
      { type: "paragraph", lines: [[{ type: "text", text: "三行目" }]] },
    ]);
  });

  it("- ・ * で始まる行は箇条書き", () => {
    expect(parseMemo("やること\n- 見積\n・請求\n* 連絡\n以上")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "やること" }]] },
      {
        type: "list",
        items: [[{ type: "text", text: "見積" }], [{ type: "text", text: "請求" }], [{ type: "text", text: "連絡" }]],
      },
      { type: "paragraph", lines: [[{ type: "text", text: "以上" }]] },
    ]);
  });

  it("記号の後に空白が無ければ箇条書きにしない", () => {
    expect(parseMemo("-5 度")).toEqual([{ type: "paragraph", lines: [[{ type: "text", text: "-5 度" }]] }]);
  });
});
