import { describe, expect, it } from "vitest";
import { buildInitRequests, parseSpreadsheetUrl, partiesCells } from "../../src/worker/sheets/init";

describe("buildInitRequests（純粋関数）", () => {
  it("空のスプレッドシート：タブ 2 つ・見出し 12 列・入力規則・書式・保護", () => {
    const req = buildInitRequests({
      sheets: [{ sheetId: 0, title: "シート1", hidden: false }],
      taskHeaders: null,
      projectId: "p1",
      parties: ["A社", "自社"],
      reinit: false,
    });
    expect(req[0]).toEqual({ addSheet: { properties: { sheetId: 1001, title: "タスク", gridProperties: { frozenRowCount: 1 } } } });
    expect(req[1]).toEqual({ addSheet: { properties: { sheetId: 1002, title: "_設定", hidden: true } } });
    const headerCells = (req.find((r) => (r as any).updateCells?.start.sheetId === 1001) as any).updateCells.rows[0].values.map(
      (v: any) => v.userEnteredValue.stringValue,
    );
    expect(headerCells).toEqual(["ID", "件名", "ボール", "担当", "状態", "期限", "発生元", "次にやること", "メモ", "作成日", "更新日", "更新者"]);
    const conditions = req
      .filter((r) => "addConditionalFormatRule" in r)
      .map((r) => (r as { addConditionalFormatRule: { rule: { booleanRule: { condition: unknown } } } }).addConditionalFormatRule.rule.booleanRule.condition);
    expect(conditions).toEqual([
      {
        type: "CUSTOM_FORMULA",
        values: [{ userEnteredValue: `=AND($F2<>"",$F2<TODAY(),$E2<>"完了",$E2<>"取り下げ")` }],
      },
      {
        type: "CUSTOM_FORMULA",
        values: [{ userEnteredValue: `=OR($E2="完了",$E2="取り下げ")` }],
      },
    ]);
    expect(req.filter((r) => "addProtectedRange" in r)).toHaveLength(1);
  });

  it("既存の「タスク」は中身を残し、足りない見出しを右端に足す", () => {
    const req = buildInitRequests({
      sheets: [{ sheetId: 5, title: "タスク", hidden: false }],
      taskHeaders: ["件名", "ID", "ボール", "状態", "独自の列"],
      projectId: "p1",
      parties: ["a", "b"],
      reinit: false,
    });
    const u = (req.find((r) => (r as any).updateCells?.start.sheetId === 5) as any).updateCells;
    expect(u.start).toEqual({ sheetId: 5, rowIndex: 0, columnIndex: 5 });
    expect(u.rows[0].values.map((v: any) => v.userEnteredValue.stringValue)).toEqual([
      "担当",
      "期限",
      "発生元",
      "次にやること",
      "メモ",
      "作成日",
      "更新日",
      "更新者",
    ]);
    // 期限は 7 列目（G）、状態は 4 列目（D）になるので、式は $G2 と $D2 を使う
    expect(JSON.stringify(req)).toContain("$G2<TODAY()");
  });

  it("つなぎ直し（reinit）では条件付き書式と保護を足さない", () => {
    const req = buildInitRequests({
      sheets: [
        { sheetId: 1001, title: "タスク", hidden: false },
        { sheetId: 1002, title: "_設定", hidden: true },
      ],
      taskHeaders: ["ID", "件名", "ボール", "担当", "状態", "期限", "発生元", "次にやること", "メモ", "作成日", "更新日", "更新者"],
      projectId: "p1",
      parties: ["a", "b"],
      reinit: true,
    });
    expect(req.some((r) => "addConditionalFormatRule" in r || "addProtectedRange" in r || "addSheet" in r)).toBe(false);
  });

  it("URL の解析", () => {
    expect(parseSpreadsheetUrl("https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=0")).toBe("1AbC_d-9");
    expect(parseSpreadsheetUrl("https://example.com/spreadsheets/d/1AbC/")).toBeNull();
    expect(parseSpreadsheetUrl("1AbC")).toBeNull();
  });
});

describe("partiesCells", () => {
  it("A3:A7 を 5 行、足りない分は空文字で埋める", () => {
    expect(partiesCells(["A社", "自社"])).toEqual({
      range: "'_設定'!A3:A7",
      values: [["A社"], ["自社"], [""], [""], [""]],
    });
  });

  it("= + - @ で始まる名前には先頭に ' を付けて数式化を防ぐ", () => {
    expect(partiesCells(["=SUM(1)", "+1", "-1", "@x"])).toEqual({
      range: "'_設定'!A3:A7",
      values: [["'=SUM(1)"], ["'+1"], ["'-1"], ["'@x"], [""]],
    });
  });
  it("見出しを足すと Z 列を超えるシートは 400 sheet_too_wide", () => {
    const wide = Array.from({ length: 15 }, (_, i) => `列${i + 1}`);
    expect(() =>
      buildInitRequests({ sheets: [{ sheetId: 5, title: "タスク", hidden: false }], taskHeaders: wide, projectId: "p1", parties: ["a", "b"], reinit: false }),
    ).toThrow(expect.objectContaining({ status: 400, code: "sheet_too_wide" }));
  });

  it("既存の「タスク」の列数が足りなければ、先に列を足す", () => {
    const req = buildInitRequests({
      sheets: [{ sheetId: 5, title: "タスク", hidden: false, columnCount: 10 }],
      taskHeaders: ["ID", "件名"],
      projectId: "p1",
      parties: ["a", "b"],
      reinit: false,
    });
    const appendIdx = req.findIndex((r) => "appendDimension" in r);
    const headerIdx = req.findIndex((r) => (r as any).updateCells?.start.sheetId === 5);
    expect(req[appendIdx]).toEqual({ appendDimension: { sheetId: 5, dimension: "COLUMNS", length: 2 } });
    expect(appendIdx).toBeLessThan(headerIdx);
  });

  it("列数が足りていれば列を足さない", () => {
    const req = buildInitRequests({
      sheets: [{ sheetId: 5, title: "タスク", hidden: false, columnCount: 26 }],
      taskHeaders: ["ID", "件名"],
      projectId: "p1",
      parties: ["a", "b"],
      reinit: false,
    });
    expect(req.some((r) => "appendDimension" in r)).toBe(false);
  });
});
