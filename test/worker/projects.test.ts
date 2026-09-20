import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, ProjectDetail, ProjectSummary } from "../../src/shared/types";
import { call, login, makeApp } from "./helpers";

describe("プロジェクト", () => {
  it("作成すると作った人が最初のメンバーになり、一覧に出る", async () => {
    const app = makeApp();
    const a = await login(app, "UA", "A");
    const res = await call(app, "POST", "/api/projects", a, { name: "A社 部門", parties: ["A社", "自社"] });
    expect(res.status).toBe(201);
    const p = await res.json<ProjectDetail>();
    expect(p.id).toMatch(/^[0-9a-z]{10}$/);
    expect(p.members.map((m) => m.lineUserId)).toEqual(["UA"]);
    expect(p.members[0].displayName).toBe("A");
    expect(p.appUrl).toBe(`https://example.test/app?p=${p.id}`);
    const list = await (await call(app, "GET", "/api/projects", a)).json<ProjectSummary[]>();
    expect(list).toEqual([{ id: p.id, name: "A社 部門", archived: false, sheetConnected: false, counts: null }]);
  });

  it("メンバーでない人には 404（存在も教えない）", async () => {
    const app = makeApp();
    const a = await login(app, "UB1");
    const b = await login(app, "UB2");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    expect((await call(app, "GET", `/api/projects/${p.id}`, b)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/zzzzzzzzzz`, b)).status).toBe(404);
    expect(await (await call(app, "GET", "/api/projects", b)).json()).toEqual([]);
  });

  it("未知の pid には archive・unarchive・PATCH も 404", async () => {
    const app = makeApp();
    const a = await login(app, "UB3");
    expect((await call(app, "POST", "/api/projects/zzzzzzzzzz/archive", a)).status).toBe(404);
    expect((await call(app, "POST", "/api/projects/zzzzzzzzzz/unarchive", a)).status).toBe(404);
    expect((await call(app, "PATCH", "/api/projects/zzzzzzzzzz", a, { name: "x" })).status).toBe(404);
  });

  it.each([
    [{ name: "", parties: ["a", "b"] }],
    [{ name: "x".repeat(41), parties: ["a", "b"] }],
    [{ name: "x", parties: ["a"] }],
    [{ name: "x", parties: ["a", "b", "c", "d", "e", "f"] }],
    [{ name: "x", parties: ["a", "x".repeat(13)] }],
    [{ name: "x", parties: ["a", "a"] }],
  ])("入力の検証 %j は 400", async (body) => {
    const app = makeApp();
    const a = await login(app, "UV");
    expect((await call(app, "POST", "/api/projects", a, body)).status).toBe(400);
  });

  it("1 人 20 件まで。アーカイブ済みは数えない", async () => {
    const app = makeApp();
    const a = await login(app, "UL");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push((await (await call(app, "POST", "/api/projects", a, { name: `p${i}`, parties: ["a", "b"] })).json<ProjectDetail>()).id);
    }
    const over = await call(app, "POST", "/api/projects", a, { name: "p20", parties: ["a", "b"] });
    expect(over.status).toBe(409);
    expect((await over.json<ApiErrorBody>()).error).toBe("project_limit");
    await call(app, "POST", `/api/projects/${ids[0]}/archive`, a);
    expect((await call(app, "POST", "/api/projects", a, { name: "p20", parties: ["a", "b"] })).status).toBe(201);
  });

  it("アーカイブ済みを戻すときも 1 人 20 件の上限を超えたら 409", async () => {
    const app = makeApp();
    const a = await login(app, "UX1");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push((await (await call(app, "POST", "/api/projects", a, { name: `q${i}`, parties: ["a", "b"] })).json<ProjectDetail>()).id);
    }
    await call(app, "POST", `/api/projects/${ids[0]}/archive`, a); // 有効 19 件
    await call(app, "POST", "/api/projects", a, { name: "q20", parties: ["a", "b"] }); // 有効 20 件に戻る
    const res = await call(app, "POST", `/api/projects/${ids[0]}/unarchive`, a);
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error).toBe("project_limit");
    const detail = await (await call(app, "GET", `/api/projects/${ids[0]}`, a)).json<ProjectDetail>();
    expect(detail.archivedAt).not.toBeNull();
  });

  it("一覧にはアーカイブ済みも archived:true で含まれる（作成の新しい順）", async () => {
    const app = makeApp();
    const a = await login(app, "UX2");
    const p1 = await (
      await call(app, "POST", "/api/projects", a, { name: "残る", parties: ["a", "b"] })
    ).json<ProjectDetail>();
    const p2 = await (
      await call(app, "POST", "/api/projects", a, { name: "消える", parties: ["a", "b"] })
    ).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${p2.id}/archive`, a);
    const list = await (await call(app, "GET", "/api/projects", a)).json<ProjectSummary[]>();
    expect(list).toEqual([
      { id: p2.id, name: "消える", archived: true, sheetConnected: false, counts: null },
      { id: p1.id, name: "残る", archived: false, sheetConnected: false, counts: null },
    ]);
  });

  it("同じ名前への PATCH は活動記録を増やさない", async () => {
    const app = makeApp();
    const a = await login(app, "UX3");
    const p = await (
      await call(app, "POST", "/api/projects", a, { name: "同じ", parties: ["a", "b"] })
    ).json<ProjectDetail>();
    await call(app, "PATCH", `/api/projects/${p.id}`, a, { name: "同じ" });
    const { results } = await env.DB.prepare("SELECT action FROM activity WHERE project_id = ? ORDER BY id")
      .bind(p.id)
      .all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["project.create"]);
  });

  it("関係者が不正で 400 のときは、名前変更も記録しない", async () => {
    const app = makeApp();
    const a = await login(app, "UR400", "A");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "元", parties: ["a", "b"] })).json<ProjectDetail>();
    const res = await call(app, "PATCH", `/api/projects/${p.id}`, a, { name: "新", parties: ["a", "a"] });
    expect(res.status).toBe(400);
    const { results } = await env.DB.prepare("SELECT action FROM activity WHERE project_id = ? ORDER BY id")
      .bind(p.id)
      .all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["project.create"]);
    const detail = await (await call(app, "GET", `/api/projects/${p.id}`, a)).json<ProjectDetail>();
    expect(detail.name).toBe("元");
  });

  it("PATCH は name か parties のどちらかが必要", async () => {
    const app = makeApp();
    const a = await login(app, "UP1");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    expect((await call(app, "PATCH", `/api/projects/${p.id}`, a, {})).status).toBe(400);
  });

  it("アーカイブ済みへの PATCH は 409", async () => {
    const app = makeApp();
    const a = await login(app, "UP2");
    const p = await (await call(app, "POST", "/api/projects", a, { name: "x", parties: ["a", "b"] })).json<ProjectDetail>();
    await call(app, "POST", `/api/projects/${p.id}/archive`, a);
    const res = await call(app, "PATCH", `/api/projects/${p.id}`, a, { name: "新" });
    expect(res.status).toBe(409);
    expect((await res.json<ApiErrorBody>()).error).toBe("archived");
  });

  it("名前・関係者の変更とアーカイブが活動記録に残る", async () => {
    const app = makeApp();
    const a = await login(app, "UC", "C");
    const created = await (
      await call(app, "POST", "/api/projects", a, { name: "元の名前", parties: ["a", "b"] })
    ).json<ProjectDetail>();
    const pid = created.id;

    await call(app, "PATCH", `/api/projects/${pid}`, a, { name: "新" });
    await call(app, "PATCH", `/api/projects/${pid}`, a, { parties: ["a", "b", "c"] });
    await call(app, "POST", `/api/projects/${pid}/archive`, a);
    await call(app, "POST", `/api/projects/${pid}/archive`, a); // 冪等：ログは増えない
    await call(app, "POST", `/api/projects/${pid}/unarchive`, a);
    await call(app, "POST", `/api/projects/${pid}/unarchive`, a); // 冪等：ログは増えない

    const { results } = await env.DB.prepare("SELECT action, detail FROM activity WHERE project_id = ? ORDER BY id")
      .bind(pid)
      .all<{ action: string; detail: string | null }>();

    expect(results.map((r) => r.action)).toEqual([
      "project.create",
      "project.rename",
      "project.parties",
      "project.archive",
      "project.unarchive",
    ]);
    expect(JSON.parse(results[0].detail as string)).toEqual({ name: "元の名前", parties: ["a", "b"] });
    expect(JSON.parse(results[1].detail as string)).toEqual({ from: "元の名前", to: "新" });
    expect(JSON.parse(results[2].detail as string)).toEqual({ from: ["a", "b"], to: ["a", "b", "c"] });
    expect(results[3].detail).toBeNull();
    expect(results[4].detail).toBeNull();
  });
});
