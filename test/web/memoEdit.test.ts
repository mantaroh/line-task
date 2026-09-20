import { describe, expect, it } from "vitest";
import { applyBold, applyLink, applyList } from "../../src/web/memo/edit";

describe("applyBold", () => {
  it("選んだ文字を ** で囲み、中身を選んだままにする", () => {
    expect(applyBold("来週まで確認", 0, 4)).toEqual({ value: "**来週まで**確認", start: 2, end: 6 });
  });
  it("何も選んでいなければ「太字」を入れて選ぶ", () => {
    expect(applyBold("ab", 1, 1)).toEqual({ value: "a**太字**b", start: 3, end: 5 });
  });
  it("すでに ** で囲まれていれば外す", () => {
    expect(applyBold("**来週**確認", 2, 4)).toEqual({ value: "来週確認", start: 0, end: 2 });
  });
});

describe("applyList", () => {
  it("選んだ行の先頭に - を付ける。空行には付けない", () => {
    expect(applyList("前\n見積\n\n請求\n後", 3, 9)).toEqual({ value: "前\n- 見積\n\n- 請求\n後", start: 2, end: 12 });
  });
  it("選んだ行がすべて箇条書きなら外す", () => {
    expect(applyList("- 見積\n- 請求", 0, 9)).toEqual({ value: "見積\n請求", start: 0, end: 5 });
  });
  it("カーソルだけなら、その行だけ", () => {
    expect(applyList("一\n二\n三", 2, 2)).toEqual({ value: "一\n- 二\n三", start: 2, end: 5 });
  });
});

describe("applyLink", () => {
  it("選んだ文字を名前にする", () => {
    expect(applyLink("手順を見る", 0, 2, "https://e.com/a")).toEqual({
      value: "[手順](https://e.com/a)を見る",
      start: 21,
      end: 21,
    });
  });
  it("選んでいなければ URL をそのまま入れる", () => {
    expect(applyLink("見る", 0, 0, "https://e.com/a")).toEqual({ value: "https://e.com/a見る", start: 15, end: 15 });
  });
  it("名前の ] は外す", () => {
    expect(applyLink("a]b", 0, 3, "https://e.com").value).toBe("[ab](https://e.com)");
  });
});
