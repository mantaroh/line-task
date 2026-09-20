import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, ProjectDetail, ProjectSummary, Task, TasksResponse } from "../../src/shared/types";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { SheetsError } from "../../src/worker/sheets/client";
import { call, login, makeApp } from "./helpers";

function makeAppWithSheets() {
  const store = memoryStore();
  const app = makeApp({ sheets: createFakeSheetsClient(store) });
  return { app, store };
}

async function setupProject(app: Hono<AppEnv>, token: string, sid?: string) {
  const created = await (
    await call(app, "POST", "/api/projects", token, { name: "A社 部門", parties: ["A社", "自社"] })
  ).json<ProjectDetail>();
  const spreadsheetId = sid ?? `sidt8${created.id}`;
  const res = await call(app, "POST", `/api/projects/${created.id}/sheet`, token, {
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  });
  const project = await res.json<ProjectDetail>();
  return { project, spreadsheetId };
}

function taskGrid(store: ReturnType<typeof memoryStore>, sid: string): string[][] {
  return store.docs.get(sid)!.sheets.find((s) => s.title === "タスク")!.grid;
}

describe("タスク API", () => {
  it("シートにもともと ID があれば、その一番大きい番号の次から振る（T-数字 以外の ID は見ない）", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8M1", "A");
    const { project, spreadsheetId } = await setupProject(app, token);
    const grid = taskGrid(store, spreadsheetId);
    const width = grid[0].length;
    const row = (id: string, title: string) => [id, title, ...Array(width - 2).fill("")];
    grid.push(row("T-001", "既存1"), row("T-025", "既存25"), row("A-999", "別の形"), row("T-abc", "数字でない"), row("T-99999999999999999999", "桁が多すぎる"));

    const r1 = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "追加1", ball: "A社" });
    expect((await r1.json<Task>()).id).toBe("T-026");
    const r2 = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "追加2", ball: "A社" });
    expect((await r2.json<Task>()).id).toBe("T-027");
    const ids = taskGrid(store, spreadsheetId).slice(1).map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ID の無い行に振るときも、シートの一番大きい番号の次にする", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8M2", "A");
    const { project, spreadsheetId } = await setupProject(app, token);
    const grid = taskGrid(store, spreadsheetId);
    const width = grid[0].length;
    grid.push(["T-010", "既存10", ...Array(width - 2).fill("")], ["", "PCで追加", ...Array(width - 2).fill("")]);

    const res = await call(app, "PATCH", `/api/projects/${project.id}/tasks/row-3`, token, {
      changes: {},
      base: { title: "PCで追加" },
    });
    expect(res.status).toBe(200);
    expect((await res.json<Task>()).id).toBe("T-011");
  });

  it("シートから行を消しても、一度振った番号は使い回さない", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8M3", "A");
    const { project, spreadsheetId } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "一件目", ball: "A社" });
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "二件目", ball: "A社" });
    taskGrid(store, spreadsheetId).splice(1);

    const res = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "三件目", ball: "A社" });
    expect((await res.json<Task>()).id).toBe("T-003");
  });

  it("追加すると T-001・T-002 と採番され、偽シートに ID・件名・ボール・未着手・作成日・更新者が入る", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8C1", "A");
    const { project, spreadsheetId } = await setupProject(app, token);

    const r1 = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "一件目", ball: "A社" });
    expect(r1.status).toBe(201);
    const t1 = await r1.json<Task>();
    expect(t1.id).toBe("T-001");
    expect(t1.ref).toBe("T-001");
    expect(t1.status).toBe("未着手");

    const r2 = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "二件目", ball: "自社" });
    expect(r2.status).toBe(201);
    expect((await r2.json<Task>()).id).toBe("T-002");

    const grid = taskGrid(store, spreadsheetId);
    expect(grid[1][0]).toBe("T-001");
    expect(grid[1][1]).toBe("一件目");
    expect(grid[1][2]).toBe("A社");
    expect(grid[1][4]).toBe("未着手");
    expect(grid[1][9]).toBe("2026-09-15 10:00");
    expect(grid[1][11]).toBe("A");
    expect(grid[2][0]).toBe("T-002");
    expect(grid[2][1]).toBe("二件目");
    expect(grid[2][2]).toBe("自社");
  });

  it("同時に 5 件追加しても番号がぶつからない", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8C2");
    const { project } = await setupProject(app, token);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: `同時${i}`, ball: "A社" }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = (await Promise.all(results.map((r) => r.json<Task>()))).map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => /^T-\d{3,}$/.test(id ?? ""))).toBe(true);
  });

  it("GET tasks が TasksResponse を返し、today が 2026-09-15、parties が関係者", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8G1");
    const { project } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "一覧", ball: "A社" });
    const res = await call(app, "GET", `/api/projects/${project.id}/tasks`, token);
    expect(res.status).toBe(200);
    const body = await res.json<TasksResponse>();
    expect(body.today).toBe("2026-09-15");
    expect(body.parties).toEqual(["A社", "自社"]);
    expect(body.tasks.map((t) => t.id)).toEqual(["T-001"]);
    expect(body.fields).toEqual([
      "id",
      "title",
      "ball",
      "assignee",
      "status",
      "due",
      "source",
      "next",
      "memo",
      "createdAt",
      "updatedAt",
      "updatedBy",
    ]);
  });

  it("2 回目の GET はキャッシュ。画面から書くと消える", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8CACHE");
    const { project, spreadsheetId } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "元の件名", ball: "A社" });

    const first = await (await call(app, "GET", `/api/projects/${project.id}/tasks`, token)).json<TasksResponse>();
    expect(first.tasks[0].title).toBe("元の件名");

    taskGrid(store, spreadsheetId)[1][1] = "PCで変更";
    const cached = await (await call(app, "GET", `/api/projects/${project.id}/tasks`, token)).json<TasksResponse>();
    expect(cached.tasks[0].title).toBe("元の件名");

    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "追加で消す", ball: "A社" });
    const fresh = await (await call(app, "GET", `/api/projects/${project.id}/tasks`, token)).json<TasksResponse>();
    expect(fresh.tasks.map((t) => t.title)).toContain("PCで変更");
    expect(fresh.tasks.map((t) => t.title)).toContain("追加で消す");
  });

  it("PATCH で件名とボールを変えると、そのセルと更新日・更新者だけが変わる", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8P1", "A");
    const { project, spreadsheetId } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "元の件名", ball: "A社" });

    const before = taskGrid(store, spreadsheetId);
    before[1][3] = "担当B";
    before[1][8] = "残るメモ";

    const res = await call(app, "PATCH", `/api/projects/${project.id}/tasks/T-001`, token, {
      changes: { title: "新しい件名", ball: "自社" },
      base: { title: "元の件名", ball: "A社" },
    });
    expect(res.status).toBe(200);
    const task = await res.json<Task>();
    expect(task.title).toBe("新しい件名");
    expect(task.ball).toBe("自社");
    const grid = taskGrid(store, spreadsheetId);
    expect(grid[1][1]).toBe("新しい件名");
    expect(grid[1][2]).toBe("自社");
    expect(grid[1][3]).toBe("担当B");
    expect(grid[1][8]).toBe("残るメモ");
    expect(grid[1][10]).toBe("2026-09-15 10:00");
    expect(grid[1][11]).toBe("A");
  });

  it("base が今の値と違えば 409 conflict、本文の task が今の行", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8CF");
    const { project } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "今の件名", ball: "A社" });
    const res = await call(app, "PATCH", `/api/projects/${project.id}/tasks/T-001`, token, {
      changes: { title: "上書き" },
      base: { title: "古い件名" },
    });
    expect(res.status).toBe(409);
    const body = await res.json<ApiErrorBody & { task: Task }>();
    expect(body.error).toBe("conflict");
    expect(body.message).toBe("ほかの人が変更しました。読み直します");
    expect(body.task.title).toBe("今の件名");
    expect(body.task.id).toBe("T-001");
  });

  it("PC で列を並べ替えた偽シートでも正しい列に書く", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8ORD");
    const { project, spreadsheetId } = await setupProject(app, token);
    const headers = taskGrid(store, spreadsheetId);
    // 件名・状態・ID・ボール・期限・担当・… の順に並べ替える
    const order = [1, 4, 0, 2, 5, 3, 6, 7, 8, 9, 10, 11];
    headers[0] = order.map((i) => headers[0][i] ?? "");

    const res = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "並べ替え", ball: "A社" });
    expect(res.status).toBe(201);
    const grid = taskGrid(store, spreadsheetId);
    expect(grid[1][0]).toBe("並べ替え");
    expect(grid[1][1]).toBe("未着手");
    expect(grid[1][2]).toBe("T-001");
    expect(grid[1][3]).toBe("A社");
  });

  it("ID の無い行（row-4）を編集すると ID が振られる。base.title が違えば 409", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8ROW");
    const { project, spreadsheetId } = await setupProject(app, token);
    const seeded = taskGrid(store, spreadsheetId);
    seeded[1] = [];
    seeded[2] = [];
    seeded[3] = ["", "PC で足した", "自社", "", "未着手"];

    const conflictRes = await call(app, "PATCH", `/api/projects/${project.id}/tasks/row-4`, token, {
      changes: { title: "x" },
      base: { title: "違う" },
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json<ApiErrorBody>()).error).toBe("conflict");
    expect(taskGrid(store, spreadsheetId)[3][0]).toBe("");

    const res = await call(app, "PATCH", `/api/projects/${project.id}/tasks/row-4`, token, {
      changes: { title: "ID を振る" },
      base: { title: "PC で足した" },
    });
    expect(res.status).toBe(200);
    const task = await res.json<Task>();
    expect(task.id).toBe("T-001");
    expect(task.ref).toBe("T-001");
    const grid = taskGrid(store, spreadsheetId);
    expect(grid[3][0]).toBe("T-001");
    expect(grid[3][1]).toBe("ID を振る");
  });

  it("ID の重複の下の行を PATCH すると 409 duplicate_id、活動記録に sheet.warning が 1 件だけ", async () => {
    const { app, store } = makeAppWithSheets();
    const token = await login(app, "T8DUP");
    const { project, spreadsheetId } = await setupProject(app, token);
    const grid = taskGrid(store, spreadsheetId);
    grid[1] = ["T-001", "上", "A社", "", "未着手"];
    grid[2] = ["T-001", "下", "A社", "", "未着手"];

    const body = { changes: { title: "新" }, base: { title: "下" } };
    const r1 = await call(app, "PATCH", `/api/projects/${project.id}/tasks/row-3`, token, body);
    expect(r1.status).toBe(409);
    const err1 = await r1.json<ApiErrorBody>();
    expect(err1.error).toBe("duplicate_id");
    expect(err1.message).toBe("ID が重複しています。PC で直してください");

    const r2 = await call(app, "PATCH", `/api/projects/${project.id}/tasks/row-3`, token, body);
    expect(r2.status).toBe(409);
    expect((await r2.json<ApiErrorBody>()).error).toBe("duplicate_id");

    const { results } = await env.DB.prepare("SELECT action, detail FROM activity WHERE project_id = ? AND action = 'sheet.warning'")
      .bind(project.id)
      .all<{ action: string; detail: string }>();
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].detail)).toEqual({ kind: "duplicate_id", taskId: "T-001" });
  });

  it("件名 101 文字・関係者に無いボール・状態に無い値・2026-02-30 の期限は 400", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8VAL");
    const { project } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "検証", ball: "A社" });

    const long = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "x".repeat(101), ball: "A社" });
    expect(long.status).toBe(400);

    const ball = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "x", ball: "誰でもない" });
    expect(ball.status).toBe(400);

    const due = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "x", ball: "A社", due: "2026-02-30" });
    expect(due.status).toBe(400);

    const status = await call(app, "PATCH", `/api/projects/${project.id}/tasks/T-001`, token, {
      changes: { status: "進行中" },
      base: { status: "未着手" },
    });
    expect(status.status).toBe(400);
  });

  it("未接続は 409 sheet_not_connected", async () => {
    const app = makeApp();
    const token = await login(app, "T8NC");
    const p = await (
      await call(app, "POST", "/api/projects", token, { name: "x", parties: ["A社", "自社"] })
    ).json<ProjectDetail>();
    const res = await call(app, "GET", `/api/projects/${p.id}/tasks`, token);
    expect(res.status).toBe(409);
    const body = await res.json<ApiErrorBody>();
    expect(body.error).toBe("sheet_not_connected");
    expect(body.message).toBe("シートがまだつながっていません");
  });

  it("偽シートが 429 を返すと 503 rate_limited", async () => {
    const store = memoryStore();
    const fake = createFakeSheetsClient(store);
    const app = makeApp({ sheets: fake });
    const token = await login(app, "T8RL");
    const { project } = await setupProject(app, token);
    const app429 = makeApp({
      sheets: {
        ...fake,
        getValues: async () => {
          throw new SheetsError(429, "");
        },
      },
    });
    const res = await call(app429, "GET", `/api/projects/${project.id}/tasks`, token);
    expect(res.status).toBe(503);
    const body = await res.json<ApiErrorBody>();
    expect(body.error).toBe("rate_limited");
    expect(body.message).toBe("混み合っています。少し待ってからやり直してください");
  });

  it("一覧の counts が {open, overdue}、読めないプロジェクトは null", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8CNT");
    const { project } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "期限切れ", ball: "A社", due: "2026-09-01" });
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "期限内", ball: "A社", due: "2026-09-20" });

    const other = await (
      await call(app, "POST", "/api/projects", token, { name: "読めない", parties: ["A社", "自社"] })
    ).json<ProjectDetail>();
    await env.DB.prepare("UPDATE projects SET spreadsheet_id = ? WHERE id = ?").bind("noaccess-t8", other.id).run();

    const list = await (await call(app, "GET", "/api/projects", token)).json<ProjectSummary[]>();
    const connected = list.find((p) => p.id === project.id)!;
    const unreadable = list.find((p) => p.id === other.id)!;
    expect(connected.counts).toEqual({ open: 2, overdue: 1 });
    expect(unreadable.sheetConnected).toBe(true);
    expect(unreadable.counts).toBeNull();
  });

  it("アーカイブ済みで POST・PATCH は 409 archived、GET は 200", async () => {
    const { app } = makeAppWithSheets();
    const token = await login(app, "T8AR");
    const { project } = await setupProject(app, token);
    await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "残る", ball: "A社" });
    await call(app, "POST", `/api/projects/${project.id}/archive`, token);

    const getRes = await call(app, "GET", `/api/projects/${project.id}/tasks`, token);
    expect(getRes.status).toBe(200);

    const postRes = await call(app, "POST", `/api/projects/${project.id}/tasks`, token, { title: "追加", ball: "A社" });
    expect(postRes.status).toBe(409);
    expect((await postRes.json<ApiErrorBody>()).error).toBe("archived");

    const patchRes = await call(app, "PATCH", `/api/projects/${project.id}/tasks/T-001`, token, {
      changes: { title: "変える" },
      base: { title: "残る" },
    });
    expect(patchRes.status).toBe(409);
    expect((await patchRes.json<ApiErrorBody>()).error).toBe("archived");
  });
});
