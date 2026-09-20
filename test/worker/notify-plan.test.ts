import { describe, expect, it } from "vitest";
import type { Task } from "../../src/shared/types";
import { keyOf } from "../../src/worker/db";
import { addDays, formatDigest, kindFor, retryKeyFor, selectForTarget } from "../../src/worker/notify/plan";
import type { NotifyTarget } from "../../src/worker/notify/types";

const today = "2026-09-15";
const target: NotifyTarget = {
  lineUserId: "U1",
  projectId: "p1",
  projectName: "A社 部門",
  parties: ["A社", "自社"],
  spreadsheetId: "s",
  party: null,
};
const task = (o: Partial<Task>): Task => ({
  ref: "T-001",
  row: 2,
  id: "T-001",
  readonly: false,
  title: "件名",
  ball: "A社",
  assignee: "",
  status: "未着手",
  due: "",
  source: "",
  next: "",
  memo: "",
  createdAt: "",
  updatedAt: "",
  updatedBy: "",
  ...o,
});

describe("通知の選び方と本文", () => {
  it("日付", () => {
    expect(addDays("2026-09-15", 1)).toBe("2026-09-16");
    expect(addDays("2026-03-01", -3)).toBe("2026-02-26");
    expect(kindFor("2026-09-16", today)).toBe("before");
    expect(kindFor("2026-09-15", today)).toBe("due");
    expect(kindFor("2026-09-12", today)).toBe("after3");
    expect(kindFor("2026-09-13", today)).toBeNull();
    expect(kindFor("2026-09-17", today)).toBeNull();
  });

  it("選び方：未完了・期限・readonly・送信済み", () => {
    const tasks = [
      task({ ref: "T-001", id: "T-001", due: "2026-09-16" }),
      task({ ref: "T-002", id: "T-002", due: "2026-09-15", status: "完了" }),
      task({ ref: "T-003", id: "T-003", due: "2026-09-12", status: "対応中" }),
      task({ ref: "row-9", row: 9, id: "T-003", due: "2026-09-15", readonly: true }),
      task({ ref: "row-10", row: 10, id: null, due: "2026/9/15" }), // parseTasks 済みなら 2026-09-15。ここでは不正な形として除外
      task({ ref: "T-004", id: "T-004", due: "2026-09-15" }),
    ];
    const logged = new Set([keyOf({ lineUserId: "U1", projectId: "p1", taskKey: "T-004", kind: "due", due: "2026-09-15" })]);
    expect(selectForTarget(target, tasks, today, logged).map((i) => [i.taskKey, i.kind])).toEqual([
      ["T-001", "before"],
      ["T-003", "after3"],
    ]);
  });

  it("自分の側", () => {
    const tasks = [
      task({ ref: "T-001", id: "T-001", ball: "A社", due: today }),
      task({ ref: "T-002", id: "T-002", ball: "自社", due: today }),
    ];
    expect(selectForTarget({ ...target, party: "自社" }, tasks, today, new Set()).map((i) => i.taskKey)).toEqual(["T-002"]);
    expect(selectForTarget({ ...target, party: "消えた側" }, tasks, today, new Set())).toHaveLength(2);
  });

  it("本文（1 プロジェクト）", () => {
    const items = selectForTarget(
      target,
      [
        task({ ref: "T-012", id: "T-012", title: "外部サービスの連携用アカウント", due: "2026-09-16" }),
        task({ ref: "T-009", id: "T-009", title: "手順書の整備", due: "2026-09-12" }),
        task({ ref: "row-5", row: 5, id: null, title: "PC で足した行", due: "2026-09-15" }),
      ],
      today,
      new Set(),
    );
    expect(formatDigest(items, today, "https://liff.line.me/X").text).toBe(
      [
        "【LINE タスクボード】9/15 のお知らせ",
        "",
        "■ A社 部門",
        "・期限から 3 日：T-009 手順書の整備",
        "  https://liff.line.me/X?p=p1&t=T-009",
        "・今日が期限：PC で足した行",
        "  https://liff.line.me/X?p=p1",
        "・明日が期限：T-012 外部サービスの連携用アカウント",
        "  https://liff.line.me/X?p=p1&t=T-012",
        "",
        "通知の設定：https://liff.line.me/X?p=p1&view=settings",
      ].join("\n"),
    );
  });

  it("本文（複数プロジェクト）は設定のリンクを最後に並べる", () => {
    const base = "https://liff.line.me/X";
    const b = selectForTarget(
      { ...target, projectId: "pb", projectName: "b 案件" },
      [task({ ref: "T-002", id: "T-002", title: "b のタスク", due: today })],
      today,
      new Set(),
    );
    const a = selectForTarget(
      { ...target, projectId: "pa", projectName: "a 案件" },
      [task({ ref: "T-001", id: "T-001", title: "a のタスク", due: today })],
      today,
      new Set(),
    );
    const items = [...b, ...a];
    const { text, included } = formatDigest(items, today, base);
    expect(text).toBe(
      [
        "【LINE タスクボード】9/15 のお知らせ",
        "",
        "■ a 案件",
        "・今日が期限：T-001 a のタスク",
        `  ${base}?p=pa&t=T-001`,
        "",
        "■ b 案件",
        "・今日が期限：T-002 b のタスク",
        `  ${base}?p=pb&t=T-002`,
        "",
        "通知の設定",
        `・a 案件：${base}?p=pa&view=settings`,
        `・b 案件：${base}?p=pb&view=settings`,
      ].join("\n"),
    );
    expect(included).toHaveLength(2);
    // 入力の並びは変えない
    expect(items.map((i) => i.projectId)).toEqual(["pb", "pa"]);
  });

  it("同じ種類なら ID の番号順、ID なしは最後", () => {
    const items = selectForTarget(
      target,
      [
        task({ ref: "row-7", row: 7, id: null, title: "無 2", due: today }),
        task({ ref: "T-10", id: "T-10", title: "十", due: today }),
        task({ ref: "row-3", row: 3, id: null, title: "無 1", due: today }),
        task({ ref: "T-9", id: "T-9", title: "九", due: today }),
      ],
      today,
      new Set(),
    );
    const lines = formatDigest(items, today, "https://x").text.split("\n").filter((l) => l.startsWith("・"));
    expect(lines).toEqual(["・今日が期限：T-9 九", "・今日が期限：T-10 十", "・今日が期限：無 1", "・今日が期限：無 2"]);
  });

  it("空なら空文字", () => {
    expect(formatDigest([], today, "https://x")).toEqual({ text: "", included: [] });
  });

  it("件名は 40 文字で切る", () => {
    const long = "あ".repeat(41);
    const { text } = formatDigest(selectForTarget(target, [task({ title: long, due: today })], today, new Set()), today, "https://x");
    expect(text).toContain(`・今日が期限：T-001 ${"あ".repeat(40)}…`);
    const just = "あ".repeat(40);
    const r2 = formatDigest(selectForTarget(target, [task({ title: just, due: today })], today, new Set()), today, "https://x");
    expect(r2.text).toContain(`・今日が期限：T-001 ${just}\n`);
  });

  it("件名の改行やタブは空白にまとめて 1 行にする", () => {
    const { text } = formatDigest(
      selectForTarget(target, [task({ title: "一行目\n二行目\t三行目", due: today })], today, new Set()),
      today,
      "https://x",
    );
    expect(text.split("\n")).toContain("・今日が期限：T-001 一行目 二行目 三行目");
  });

  it("5,000 文字を超える分は載せず、件数を書く", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      task({ ref: `T-${i + 1}`, id: `T-${i + 1}`, title: "い".repeat(40), due: today }),
    );
    const { text, included } = formatDigest(
      selectForTarget(target, many, today, new Set()),
      today,
      "https://liff.line.me/1234567890-abcdefgh",
    );
    expect([...text].length).toBeLessThanOrEqual(5000);
    expect(included.length).toBeLessThan(200);
    expect(text).toContain(`ほか ${200 - included.length} 件はアプリで確認してください`);
    // 番号順の先頭から載り、「ほか」は設定の行の直前
    expect(included.map((i) => i.taskKey).slice(0, 3)).toEqual(["T-1", "T-2", "T-3"]);
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("通知の設定：https://liff.line.me/1234567890-abcdefgh?p=p1&view=settings");
    expect(lines.at(-3)).toBe(`ほか ${200 - included.length} 件はアプリで確認してください`);
  });

  it("切ったときの設定の行は載ったプロジェクトだけ", () => {
    const mk = (pid: string, name: string, n: number) =>
      selectForTarget(
        { ...target, projectId: pid, projectName: name },
        Array.from({ length: n }, (_, i) => task({ ref: `T-${i + 1}`, id: `T-${i + 1}`, title: "う".repeat(40), due: today })),
        today,
        new Set(),
      );
    const items = [...mk("pa", "a 案件", 150), ...mk("pb", "b 案件", 5)];
    const { text, included } = formatDigest(items, today, "https://x");
    expect([...text].length).toBeLessThanOrEqual(5000);
    expect(included.every((i) => i.projectId === "pa")).toBe(true);
    expect(text).not.toContain("b 案件");
    expect(text).toContain(`ほか ${155 - included.length} 件はアプリで確認してください`);
    expect(text.endsWith("通知の設定：https://x?p=pa&view=settings")).toBe(true);
  });

  it("Retry Key は利用者と日付で決まる UUID", async () => {
    const k = await retryKeyFor("U1", today);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await retryKeyFor("U1", today)).toBe(k);
    expect(await retryKeyFor("U1", "2026-09-16")).not.toBe(k);
  });
});
