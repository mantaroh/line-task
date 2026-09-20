import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bindSheet } from "../../src/worker/db";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import { SheetsError } from "../../src/worker/sheets/client";
import type { ApiErrorBody, ProjectDetail } from "../../src/shared/types";
import { call, login, makeApp } from "./helpers";

describe("シートをつなぐ", () => {
  it("つなぐと「タスク」「_設定」ができ、GET の spreadsheetId が入り、活動記録が残る", async () => {
    const store = memoryStore();
    const app = makeApp({ sheets: createFakeSheetsClient(store) });
    const a = await login(app, "S1");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["A社", "自社"] })).json<ProjectDetail>();

    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-1/edit" });
    expect(res.status).toBe(200);
    const detail = await res.json<ProjectDetail>();
    expect(detail.spreadsheetId).toBe("sid-1");
    expect(detail.spreadsheetUrl).toBe("https://docs.google.com/spreadsheets/d/sid-1/edit");

    const doc = store.docs.get("sid-1")!;
    expect(doc.sheets.map((s) => s.title)).toEqual(expect.arrayContaining(["タスク", "_設定"]));
    const config = doc.sheets.find((s) => s.title === "_設定")!;
    expect(config.grid[0]).toEqual(["line-task-board", p.id]);

    const getRes = await (await call(app, "GET", `/api/projects/${p.id}`, a)).json<ProjectDetail>();
    expect(getRes.spreadsheetId).toBe("sid-1");

    const { results } = await env.DB.prepare("SELECT action, detail FROM activity WHERE project_id = ? ORDER BY id")
      .bind(p.id)
      .all<{ action: string; detail: string | null }>();
    expect(results.map((r) => r.action)).toEqual(["project.create", "project.sheet_bind"]);
    expect(JSON.parse(results[1].detail!)).toEqual({ from: null, to: "sid-1" });
  });

  it("URL の形が違うと 400 sheet_url", async () => {
    const app = makeApp();
    const a = await login(app, "S2");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://example.com/x" });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error).toBe("sheet_url");
  });

  it("アクセスできないシートは 400 sheet_no_access（メッセージにサービスアカウントのメール）", async () => {
    const app = makeApp();
    const a = await login(app, "S3");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, {
      url: "https://docs.google.com/spreadsheets/d/noaccess-1/edit",
    });
    expect(res.status).toBe(400);
    const body = await res.json<ApiErrorBody>();
    expect(body.error).toBe("sheet_no_access");
    expect(body.message).toContain("sa@test.iam.gserviceaccount.com");
  });

  it("閲覧のみのシートは 400 sheet_readonly", async () => {
    const app = makeApp();
    const a = await login(app, "S4");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, {
      url: "https://docs.google.com/spreadsheets/d/readonly-1/edit",
    });
    expect(res.status).toBe(400);
    expect((await res.json<ApiErrorBody>()).error).toBe("sheet_readonly");
  });

  it("プロジェクト A でつないだシートを B でつなごうとすると 409 sheet_in_use", async () => {
    const store = memoryStore();
    const app = makeApp({ sheets: createFakeSheetsClient(store) });
    const a = await login(app, "S5A");
    const b = await login(app, "S5B");
    const pa = await (await call(app, "POST", "/api/projects", a, { name: "a", parties: ["a", "b"] })).json<ProjectDetail>();
    const pb = await (await call(app, "POST", "/api/projects", b, { name: "b", parties: ["a", "b"] })).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${pa.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-shared/edit" });
    const res = await call(app, "POST", `/api/projects/${pb.id}/sheet`, b, { url: "https://docs.google.com/spreadsheets/d/sid-shared/edit" });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error).toBe("sheet_in_use");
  });

  it("_設定!B1 が別の pid の偽シートを新規につなごうとすると 409 sheet_in_use", async () => {
    const store = memoryStore();
    store.docs.set("sid-foreign", {
      title: "他人のシート",
      sheets: [
        { sheetId: 0, title: "シート1", hidden: false, grid: [] },
        { sheetId: 1, title: "_設定", hidden: true, grid: [["line-task-board", "other-pid"]] },
      ],
      requests: [],
    });
    const app = makeApp({ sheets: createFakeSheetsClient(store) });
    const a = await login(app, "S6");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-foreign/edit" });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error).toBe("sheet_in_use");
  });

  it("同じプロジェクトでつなぎ直すと 200（reinit）", async () => {
    const store = memoryStore();
    const app = makeApp({ sheets: createFakeSheetsClient(store) });
    const a = await login(app, "S7");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-re/edit" });
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-re/edit" });
    expect(res.status).toBe(200);
  });

  it("つないだあとの PATCH parties でシートの A3:A7 が更新され、sheetSynced が true になる", async () => {
    const store = memoryStore();
    const app = makeApp({ sheets: createFakeSheetsClient(store) });
    const a = await login(app, "S8");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-8/edit" });
    const res = await call(app, "PATCH", `/api/projects/${p.id}`, a, { parties: ["a", "b", "c"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectDetail & { sheetSynced?: boolean };
    expect(body.sheetSynced).toBe(true);
    const config = store.docs.get("sid-8")!.sheets.find((s) => s.title === "_設定")!;
    expect(config.grid.slice(2, 7).map((r) => r[0] ?? "")).toEqual(["a", "b", "c", "", ""]);
  });

  it("シートをつなげていないプロジェクトへの PATCH parties には sheetSynced を付けない", async () => {
    const app = makeApp();
    const a = await login(app, "S9");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "PATCH", `/api/projects/${p.id}`, a, { parties: ["a", "b", "c"] });
    const body = (await res.json()) as ProjectDetail & { sheetSynced?: boolean };
    expect(body.sheetSynced).toBeUndefined();
  });

  it("タスク見出し行の getValues が 429 なら 503 rate_limited", async () => {
    const store = memoryStore();
    store.docs.set("sid-hdr-429", {
      title: "x",
      sheets: [
        { sheetId: 1001, title: "タスク", hidden: false, grid: [["ID", "件名"]] },
        { sheetId: 1002, title: "_設定", hidden: true, grid: [["line-task-board"]] },
      ],
      requests: [],
    });
    const fake = createFakeSheetsClient(store);
    let n = 0;
    const app = makeApp({
      sheets: {
        ...fake,
        async getValues(id, range) {
          n += 1;
          if (n === 2) throw new SheetsError(429, "");
          return fake.getValues(id, range);
        },
      },
    });
    const a = await login(app, "S11");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, {
      url: "https://docs.google.com/spreadsheets/d/sid-hdr-429/edit",
    });
    expect(res.status).toBe(503);
    expect((await res.json<ApiErrorBody>()).error).toBe("rate_limited");
  });

  it("プロジェクト A の sheet_bindings だけ先にある状態で B が同じ sid をつなぐと 409 で B の spreadsheet_id は変わらない", async () => {
    const app = makeApp();
    const a = await login(app, "S12A");
    const b = await login(app, "S12B");
    const pa = await (await call(app, "POST", "/api/projects", a, { name: "a", parties: ["a", "b"] })).json<ProjectDetail>();
    const pb = await (await call(app, "POST", "/api/projects", b, { name: "b", parties: ["a", "b"] })).json<ProjectDetail>();
    await env.DB.prepare("INSERT INTO sheet_bindings (spreadsheet_id, project_id, bound_at) VALUES (?, ?, ?)")
      .bind("sid-race", pa.id, "2026-09-15T10:00:00+09:00")
      .run();
    await expect(bindSheet(env.DB, pb.id, "sid-race", "2026-09-15T10:00:01+09:00")).rejects.toMatchObject({
      status: 409,
      code: "sheet_in_use",
    });
    const row = await env.DB.prepare("SELECT spreadsheet_id FROM projects WHERE id = ?")
      .bind(pb.id)
      .first<{ spreadsheet_id: string | null }>();
    expect(row?.spreadsheet_id).toBeNull();
  });

  it("アーカイブ済みでは 409 archived", async () => {
    const app = makeApp();
    const a = await login(app, "S10");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${p.id}/archive`, a);
    const res = await call(app, "POST", `/api/projects/${p.id}/sheet`, a, { url: "https://docs.google.com/spreadsheets/d/sid-9/edit" });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error).toBe("archived");
  });
});
