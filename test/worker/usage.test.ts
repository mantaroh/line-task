import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/shared/types";
import { pruneAccessLog, setLineFriend } from "../../src/worker/usage/store";
import { call, login, makeApp } from "./helpers";

type AccessLogRow = { line_user_id: string; project_id: string | null; view: string; at: string };

async function rowsFor(uid: string): Promise<AccessLogRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT line_user_id, project_id, view, at FROM access_log WHERE line_user_id = ? ORDER BY id",
  )
    .bind(uid)
    .all<AccessLogRow>();
  return results;
}

describe("POST /api/usage", () => {
  it("home を送ると 204、access_log に 1 行残る", async () => {
    const app = makeApp();
    const token = await login(app, "UA1", "A");
    const res = await call(app, "POST", "/api/usage", token, { view: "home" });
    expect(res.status).toBe(204);
    const rows = await rowsFor("UA1");
    expect(rows).toEqual([{ line_user_id: "UA1", project_id: null, view: "home", at: "2026-09-15T10:00:00+09:00" }]);
  });

  it("project と自分のプロジェクトの pid → 204、project_id が入る", async () => {
    const app = makeApp();
    const token = await login(app, "UB1", "A");
    const p = await (
      await call(app, "POST", "/api/projects", token, { name: "利用状況", parties: ["A社", "自社"] })
    ).json<{ id: string }>();
    const res = await call(app, "POST", "/api/usage", token, { view: "project", pid: p.id });
    expect(res.status).toBe(204);
    const rows = await rowsFor("UB1");
    expect(rows.at(-1)).toEqual({ line_user_id: "UB1", project_id: p.id, view: "project", at: "2026-09-15T10:00:00+09:00" });
  });

  it.each([
    [{ view: "project" }],
    [{ view: "home", pid: "p1" }],
    [{ view: "admin" }],
    [[]],
  ])("不正な本文 %j は 400 validation、行は増えない", async (body) => {
    const app = makeApp();
    const token = await login(app, "UC1", "A");
    const res = await call(app, "POST", "/api/usage", token, body);
    expect(res.status).toBe(400);
    const err = await res.json<ApiErrorBody>();
    expect(err.error).toBe("validation");
    expect(typeof err.message).toBe("string");
    expect(await rowsFor("UC1")).toEqual([]);
  });

  it("メンバーでないプロジェクト・存在しない pid は 404、行は増えない", async () => {
    const app = makeApp();
    const owner = await login(app, "UD1", "A");
    const other = await login(app, "UD2", "B");
    const p = await (
      await call(app, "POST", "/api/projects", owner, { name: "利用状況2", parties: ["A社", "自社"] })
    ).json<{ id: string }>();

    const notMember = await call(app, "POST", "/api/usage", other, { view: "project", pid: p.id });
    expect(notMember.status).toBe(404);
    expect(await rowsFor("UD2")).toEqual([]);

    const missing = await call(app, "POST", "/api/usage", owner, { view: "project", pid: "no-such-project" });
    expect(missing.status).toBe(404);
    expect(await rowsFor("UD1")).toEqual([]);
  });

  it("セッションが無ければ 401", async () => {
    const app = makeApp();
    const res = await call(app, "POST", "/api/usage", undefined, { view: "home" });
    expect(res.status).toBe(401);
  });
});

describe("pruneAccessLog", () => {
  it("境界より前だけ消える（境界ちょうどは残る）", async () => {
    const app = makeApp();
    await login(app, "UE1", "A");
    const insert = env.DB.prepare(
      `INSERT INTO access_log (at, line_user_id, project_id, view) VALUES (?, 'UE1', NULL, 'home')`,
    );
    await insert.bind("2026-08-10T09:00:00+09:00").run();
    await insert.bind("2026-08-16T09:00:00+09:00").run();
    await insert.bind("2026-08-16T09:00:01+09:00").run();

    await pruneAccessLog(env.DB, "2026-08-16T09:00:00+09:00");

    const { results } = await env.DB.prepare("SELECT at FROM access_log WHERE line_user_id = 'UE1' ORDER BY at").all<{
      at: string;
    }>();
    expect(results.map((r) => r.at)).toEqual(["2026-08-16T09:00:00+09:00", "2026-08-16T09:00:01+09:00"]);
  });
});

describe("setLineFriend", () => {
  it("users.line_friend が 1 → 0 に変わり、line_friend_checked_at が入る", async () => {
    const app = makeApp();
    await login(app, "UF1", "A");

    await setLineFriend(env.DB, "UF1", true, "2026-09-15T10:00:00+09:00");
    let row = await env.DB.prepare("SELECT line_friend, line_friend_checked_at FROM users WHERE line_user_id = ?")
      .bind("UF1")
      .first<{ line_friend: number; line_friend_checked_at: string }>();
    expect(row).toEqual({ line_friend: 1, line_friend_checked_at: "2026-09-15T10:00:00+09:00" });

    await setLineFriend(env.DB, "UF1", false, "2026-09-15T10:30:00+09:00");
    row = await env.DB.prepare("SELECT line_friend, line_friend_checked_at FROM users WHERE line_user_id = ?")
      .bind("UF1")
      .first<{ line_friend: number; line_friend_checked_at: string }>();
    expect(row).toEqual({ line_friend: 0, line_friend_checked_at: "2026-09-15T10:30:00+09:00" });
  });
});
