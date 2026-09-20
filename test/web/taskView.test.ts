import { describe, expect, it } from "vitest";
import type { Task } from "../../src/shared/types";
import { countTasks, dueTone, filterTasks, groupByBall, isOverdue } from "../../src/shared/taskView";

function t(overrides: Partial<Task> = {}): Task {
  const ref = overrides.ref ?? "T-001";
  const base: Task = {
    ref,
    row: 2,
    id: ref.startsWith("T-") ? ref : null,
    readonly: false,
    title: "",
    ball: "",
    assignee: "",
    status: "未着手",
    due: "",
    source: "",
    next: "",
    memo: "",
    createdAt: "",
    updatedAt: "",
    updatedBy: "",
  };
  return { ...base, ...overrides };
}

const today = "2026-09-15";

describe("taskView", () => {
  it("期限切れ", () => {
    expect(isOverdue({ status: "対応中", due: "2026-09-14" }, today)).toBe(true);
    expect(isOverdue({ status: "対応中", due: "2026-09-15" }, today)).toBe(false);
    expect(isOverdue({ status: "完了", due: "2026-09-01" }, today)).toBe(false);
    expect(isOverdue({ status: "未着手", due: "" }, today)).toBe(false);
  });

  it("ボールごとに分け、期限の近い順・期限なしは最後", () => {
    const tasks = [
      t({ ref: "T-003", id: "T-003", ball: "A社", due: "" }),
      t({ ref: "T-001", id: "T-001", ball: "自社", due: "2026-09-20" }),
      t({ ref: "T-002", id: "T-002", ball: "A社", due: "2026-09-19" }),
      t({ ref: "row-9", id: null, ball: "不明", due: "" }),
    ];
    expect(groupByBall(tasks, ["A社", "自社"]).map((g) => [g.ball, g.tasks.map((x) => x.ref)])).toEqual([
      ["A社", ["T-002", "T-003"]],
      ["自社", ["T-001"]],
      ["その他", ["row-9"]],
    ]);
  });

  it("絞り込み", () => {
    const tasks = [
      t({ ref: "T-001", status: "完了" }),
      t({ ref: "T-002", status: "取り下げ" }),
      t({ ref: "T-003", status: "対応中", due: "2026-09-01", assignee: "担当B" }),
      t({ ref: "T-004", status: "未着手" }),
    ];
    expect(filterTasks(tasks, "open", null, today).map((x) => x.ref)).toEqual(["T-003", "T-004"]);
    expect(filterTasks(tasks, "overdue", null, today).map((x) => x.ref)).toEqual(["T-003"]);
    expect(filterTasks(tasks, "done", null, today).map((x) => x.ref)).toEqual(["T-001", "T-002"]);
    expect(filterTasks(tasks, "open", "担当B", today).map((x) => x.ref)).toEqual(["T-003"]);
    expect(countTasks(tasks, today)).toEqual({ open: 2, overdue: 1 });
  });
});

describe("dueTone", () => {
  it("期限切れ・今日・明日・それ以外・期限なし", () => {
    expect(dueTone({ status: "対応中", due: "2026-09-14" }, today)).toBe("overdue");
    expect(dueTone({ status: "対応中", due: "2026-09-15" }, today)).toBe("soon");
    expect(dueTone({ status: "未着手", due: "2026-09-16" }, today)).toBe("soon");
    expect(dueTone({ status: "未着手", due: "2026-09-17" }, today)).toBe("normal");
    expect(dueTone({ status: "未着手", due: "" }, today)).toBe("none");
  });
  it("月末の翌日も明日として扱う", () => {
    expect(dueTone({ status: "未着手", due: "2026-10-01" }, "2026-09-30")).toBe("soon");
  });
  it("完了・取り下げは期限があっても normal", () => {
    expect(dueTone({ status: "完了", due: "2026-09-01" }, today)).toBe("normal");
    expect(dueTone({ status: "取り下げ", due: "2026-09-15" }, today)).toBe("normal");
  });
});

describe("groupByBall の先頭にする側", () => {
  const tasks = [
    t({ ref: "T-001", id: "T-001", ball: "A社" }),
    t({ ref: "T-002", id: "T-002", ball: "自社" }),
    t({ ref: "row-9", id: null, ball: "不明" }),
  ];
  it("自分の側を一番上にする", () => {
    expect(groupByBall(tasks, ["A社", "自社"], "自社").map((g) => g.ball)).toEqual(["自社", "A社", "その他"]);
  });
  it("側が無い・関係者に無いときは今の順のまま", () => {
    expect(groupByBall(tasks, ["A社", "自社"], null).map((g) => g.ball)).toEqual(["A社", "自社", "その他"]);
    expect(groupByBall(tasks, ["A社", "自社"], "消えた側").map((g) => g.ball)).toEqual(["A社", "自社", "その他"]);
  });
});
