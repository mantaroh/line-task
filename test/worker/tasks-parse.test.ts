import { describe, expect, it } from "vitest";
import { parseTasks, toCellInput } from "../../src/worker/sheets/tasks";

describe("タスク表の解析", () => {
  it("列の順が変わっても見出しで探す", () => {
    const { tasks, fields } = parseTasks({
      headers: ["件名", "状態", "ID", "ボール", "期限"],
      rows: [
        ["A 社に連絡", "対応中", "T-001", "A社", "2026/9/19"],
        ["", "", "", "", ""],
        ["PC で足した", "未着手", "", "自社", ""],
      ],
    });
    expect(fields).toEqual(["id", "title", "ball", "status", "due"]);
    expect(tasks.map((t) => [t.ref, t.row, t.title, t.due])).toEqual([
      ["T-001", 2, "A 社に連絡", "2026-09-19"],
      ["row-4", 4, "PC で足した", ""],
    ]);
  });

  it("ID の重複は上の行を使い、下の行は編集できない", () => {
    const r = parseTasks({
      headers: ["ID", "件名", "ボール", "状態"],
      rows: [
        ["T-001", "上", "a", "未着手"],
        ["T-001", "下", "a", "未着手"],
      ],
    });
    expect(r.duplicates).toEqual(["T-001"]);
    expect(r.tasks.map((t) => [t.ref, t.readonly])).toEqual([
      ["T-001", false],
      ["row-3", true],
    ]);
  });

  it("数式にならないようにする", () => {
    expect(toCellInput("=IMPORTXML(1)")).toBe("'=IMPORTXML(1)");
    expect(toCellInput("-1")).toBe("'-1");
    expect(toCellInput("2026-09-19")).toBe("2026-09-19");
  });
});
