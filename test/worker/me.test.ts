import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiErrorBody, LineFriendResponse, MemberSettings, ProjectDetail } from "../../src/shared/types";
import { createFakeMessagingClient } from "../../src/worker/dev/fake-messaging";
import type { AppEnv } from "../../src/worker/env";
import { MessagingError } from "../../src/worker/line/messaging";
import { call, login, makeApp } from "./helpers";

async function createProject(app: Hono<AppEnv>, token: string, parties: string[], name = "通知"): Promise<ProjectDetail> {
  const res = await call(app, "POST", "/api/projects", token, { name, parties });
  expect(res.status).toBe(201);
  return res.json<ProjectDetail>();
}

describe("自分の通知の設定", () => {
  it("既定は ON・すべて。変更できて、他のメンバーには影響しない", async () => {
    const app = makeApp();
    const a = await login(app, "NA1", "A");
    const b = await login(app, "NA2", "B");
    const p = await createProject(app, a, ["A社", "自社"]);
    const inv = await (await call(app, "POST", `/api/projects/${p.id}/invites`, a, { days: 7 })).json<{ url: string }>();
    const inviteToken = new URL(inv.url).searchParams.get("invite")!;
    expect((await call(app, "POST", `/api/invites/${inviteToken}/accept`, b)).status).toBe(200);

    expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, a)).json()).toEqual({ notify: true, party: null });
    const res = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { notify: false, party: "A社" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notify: false, party: "A社" });
    expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, a)).json()).toEqual({ notify: false, party: "A社" });
    expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, b)).json()).toEqual({ notify: true, party: null });

    // 片方だけの変更は、もう片方を残す
    const onlyNotify = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { notify: true });
    expect(await onlyNotify.json()).toEqual({ notify: true, party: "A社" });
    const onlyParty = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { party: null });
    expect(await onlyParty.json()).toEqual({ notify: true, party: null });

    const { results } = await env.DB.prepare("SELECT action FROM activity WHERE project_id = ?").bind(p.id).all();
    expect(results.map((r) => (r as { action: string }).action)).toEqual(["project.create", "invite.create", "member.join"]);
  });

  it("プロジェクト詳細のメンバーに側が入り、関係者から消えた側は null", async () => {
    const app = makeApp();
    const a = await login(app, "NP1", "A");
    const p = await createProject(app, a, ["A社", "自社"]);
    const before = await (await call(app, "GET", `/api/projects/${p.id}`, a)).json<ProjectDetail>();
    expect(before.members.map((m) => [m.lineUserId, m.party])).toEqual([["NP1", null]]);
    await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { party: "自社" });
    const after = await (await call(app, "GET", `/api/projects/${p.id}`, a)).json<ProjectDetail>();
    expect(after.members.map((m) => [m.lineUserId, m.party])).toEqual([["NP1", "自社"]]);
    const renamed = await (await call(app, "PATCH", `/api/projects/${p.id}`, a, { parties: ["A社", "当方"] })).json<ProjectDetail>();
    expect(renamed.members.map((m) => m.party)).toEqual([null]);
  });

  it("関係者から消えた側は null として返す", async () => {
    const app = makeApp();
    const a = await login(app, "NB1", "A");
    const p = await createProject(app, a, ["A社", "自社"]);
    await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { party: "A社" });
    const upd = await call(app, "PATCH", `/api/projects/${p.id}`, a, { parties: ["社内", "自社"] });
    expect(upd.status).toBe(200);
    expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, a)).json()).toEqual({ notify: true, party: null });
    // 値そのものは残す（設計書 §5）
    const row = await env.DB.prepare("SELECT party FROM members WHERE project_id = ? AND line_user_id = ?")
      .bind(p.id, "NB1")
      .first<{ party: string | null }>();
    expect(row?.party).toBe("A社");
    // notify だけの PATCH でも、応答の party は null
    const res = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { notify: false });
    expect(await res.json<MemberSettings>()).toEqual({ notify: false, party: null });
  });

  it.each([[{}], [{ notify: "yes" }], [{ party: "知らない側" }], [{ party: 1 }], [[]], [null], [{ notify: null }]])(
    "不正な PATCH %j は 400",
    async (body) => {
      const app = makeApp();
      const a = await login(app, "NC1", "A");
      const p = await createProject(app, a, ["A社", "自社"]);
      const res = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, body);
      expect(res.status).toBe(400);
      const err = await res.json<ApiErrorBody>();
      expect(err.error).toBe("validation");
      expect(typeof err.message).toBe("string");
      expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, a)).json()).toEqual({ notify: true, party: null });
    },
  );

  it("メンバーでなければ 404、アーカイブ済みの PATCH は 409", async () => {
    const app = makeApp();
    const a = await login(app, "ND1", "A");
    const other = await login(app, "ND2", "B");
    const p = await createProject(app, a, ["A社", "自社"]);
    expect((await call(app, "GET", `/api/projects/${p.id}/me`, other)).status).toBe(404);
    const patchOther = await call(app, "PATCH", `/api/projects/${p.id}/me`, other, { notify: false });
    expect(patchOther.status).toBe(404);
    expect((await patchOther.json<ApiErrorBody>()).error).toBe("not_found");
    expect((await call(app, "GET", `/api/projects/nope/me`, a)).status).toBe(404);
    expect((await call(app, "GET", `/api/projects/${p.id}/me`)).status).toBe(401);

    expect((await call(app, "POST", `/api/projects/${p.id}/archive`, a)).status).toBeLessThan(300);
    const archived = await call(app, "PATCH", `/api/projects/${p.id}/me`, a, { notify: false });
    expect(archived.status).toBe(409);
    expect((await archived.json<ApiErrorBody>()).error).toBe("archived");
    // 読むのはアーカイブ済みでもできる
    expect(await (await call(app, "GET", `/api/projects/${p.id}/me`, a)).json()).toEqual({ notify: true, party: null });
  });
});

describe("LINE の友だちの状態", () => {
  it("友だちの状態", async () => {
    const friend = makeApp({
      messaging: createFakeMessagingClient({ friends: (id) => id === "NF1" }),
      lineOaBasicId: "@example",
    });
    const t1 = await login(friend, "NF1");
    expect(await (await call(friend, "GET", "/api/me/line-friend", t1)).json()).toEqual({
      friend: true,
      addFriendUrl: "https://line.me/R/ti/p/@example",
    });
    const t2 = await login(friend, "NF2");
    expect(await (await call(friend, "GET", "/api/me/line-friend", t2)).json()).toEqual({
      friend: false,
      addFriendUrl: "https://line.me/R/ti/p/@example",
    });

    const none = makeApp({ messaging: null, lineOaBasicId: null });
    const t3 = await login(none, "NF3");
    expect(await (await call(none, "GET", "/api/me/line-friend", t3)).json()).toEqual({ friend: null, addFriendUrl: null });

    const noOa = makeApp({ lineOaBasicId: null });
    const t5 = await login(noOa, "NF5");
    expect(await (await call(noOa, "GET", "/api/me/line-friend", t5)).json()).toEqual({ friend: null, addFriendUrl: null });

    const broken = makeApp({
      messaging: createFakeMessagingClient({
        friends: () => {
          throw new MessagingError(500, "x");
        },
      }),
    });
    const t4 = await login(broken, "NF4");
    const res = await call(broken, "GET", "/api/me/line-friend", t4);
    expect(res.status).toBe(200);
    expect(await res.json<LineFriendResponse>()).toEqual({ friend: null, addFriendUrl: "https://line.me/R/ti/p/@test-oa" });
  });

  it("セッションが無ければ 401", async () => {
    const app = makeApp();
    expect((await call(app, "GET", "/api/me/line-friend")).status).toBe(401);
  });

  it("取得すると users.line_friend が保存される。確認が失敗したときは NULL のまま", async () => {
    const friend = makeApp({ messaging: createFakeMessagingClient({ friends: (id) => id === "NG1" }) });
    const t1 = await login(friend, "NG1");
    expect((await call(friend, "GET", "/api/me/line-friend", t1)).status).toBe(200);
    const row1 = await env.DB.prepare("SELECT line_friend FROM users WHERE line_user_id = ?")
      .bind("NG1")
      .first<{ line_friend: number | null }>();
    expect(row1?.line_friend).toBe(1);

    const t2 = await login(friend, "NG2");
    expect((await call(friend, "GET", "/api/me/line-friend", t2)).status).toBe(200);
    const row2 = await env.DB.prepare("SELECT line_friend FROM users WHERE line_user_id = ?")
      .bind("NG2")
      .first<{ line_friend: number | null }>();
    expect(row2?.line_friend).toBe(0);

    const broken = makeApp({
      messaging: createFakeMessagingClient({
        friends: () => {
          throw new MessagingError(500, "x");
        },
      }),
    });
    const t3 = await login(broken, "NG3");
    expect((await call(broken, "GET", "/api/me/line-friend", t3)).status).toBe(200);
    const row3 = await env.DB.prepare("SELECT line_friend FROM users WHERE line_user_id = ?")
      .bind("NG3")
      .first<{ line_friend: number | null }>();
    expect(row3?.line_friend).toBe(null);
  });
});
