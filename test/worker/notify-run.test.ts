import { env } from "cloudflare:test";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../../src/shared/types";
import { listNotifyTargets } from "../../src/worker/db";
import { createFakeMessagingClient } from "../../src/worker/dev/fake-messaging";
import { createFakeSheetsClient, memoryStore } from "../../src/worker/dev/fake-sheets";
import type { AppEnv } from "../../src/worker/env";
import { createApp } from "../../src/worker/index";
import { runNotifications } from "../../src/worker/notify/run";
import { call, login, makeApp } from "./helpers";

// テストの時計は 2026-09-15T10:00:00+09:00（today = 2026-09-15）
const NOW = new Date("2026-09-15T01:00:00Z");
const now = () => NOW;

// pool-workers は同じファイル内のテストで D1 を分けない（前のテストの行が見える）。
// 前のテストのプロジェクトは、このテストの偽シートに無いので読めずに skipped.sheet に入る。
// その人数を実行前に数えて、期待値に足す。
type Store = ReturnType<typeof memoryStore>;
async function unreadableTargets(store: Store): Promise<number> {
  const targets = await listNotifyTargets(env.DB);
  return targets.filter((t) => {
    if (t.spreadsheetId.includes("noaccess")) return true;
    const doc = store.docs.get(t.spreadsheetId);
    return !doc || !doc.sheets.some((s) => s.title === "タスク");
  }).length;
}

type Sheets = ReturnType<typeof createFakeSheetsClient>;

async function setup(sheets: Sheets, uid: string) {
  const app = makeApp({ sheets });
  const owner = await login(app, uid, `名前${uid}`);
  const project = await (
    await call(app, "POST", "/api/projects", owner, { name: `通知${uid}`, parties: ["A社", "自社"] })
  ).json<ProjectDetail>();
  const pid = project.id;
  const bind = await call(app, "POST", `/api/projects/${pid}/sheet`, owner, {
    url: `https://docs.google.com/spreadsheets/d/sid-run-${uid}/edit`,
  });
  expect(bind.status).toBe(200);
  const tasks = [
    { title: "明日の件", ball: "A社", due: "2026-09-16" },
    { title: "今日の件", ball: "自社", due: "2026-09-15" },
    { title: "3 日前の件", ball: "A社", due: "2026-09-12" },
    { title: "対象外の件", ball: "自社", due: "2026-09-13" },
  ];
  for (const t of tasks) {
    expect((await call(app, "POST", `/api/projects/${pid}/tasks`, owner, t)).status).toBe(201);
  }
  return { app, pid, owner };
}

async function invite(app: Hono<AppEnv>, pid: string, owner: string, uid: string): Promise<string> {
  const token = await login(app, uid, `名前${uid}`);
  const inv = await (await call(app, "POST", `/api/projects/${pid}/invites`, owner, { days: 7 })).json<{ url: string }>();
  const inviteToken = new URL(inv.url).searchParams.get("invite")!;
  expect((await call(app, "POST", `/api/invites/${inviteToken}/accept`, token)).status).toBe(200);
  return token;
}

async function logCount(uid: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_log WHERE line_user_id = ?")
    .bind(uid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const ZERO = { recipients: 0, sent: 0, items: 0, skipped: { notFriend: 0, quota: 0, error: 0, sheet: 0 } };

describe("期限の通知の実行", () => {
  it("前日・当日・3 日後を 1 通にまとめて送り、再実行しても送らない", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { pid } = await setup(sheets, "RN1");
    const messaging = createFakeMessagingClient();
    const deps = { sheets, messaging, now };

    const other = await unreadableTargets(store);
    const r1 = await runNotifications(env, deps);
    expect(r1).toEqual({ recipients: 1, sent: 1, items: 3, skipped: { notFriend: 0, quota: 0, error: 0, sheet: other } });
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0].to).toBe("RN1");
    const text = messaging.sent[0].text;
    expect(text).toContain("・明日が期限：");
    expect(text).toContain("・今日が期限：");
    expect(text).toContain("・期限から 3 日：");
    expect(text).not.toContain("対象外の件");
    expect(text).toContain(`https://example.test/app?p=${pid}&view=settings`);
    expect(await logCount("RN1")).toBe(3);

    const r2 = await runNotifications(env, deps);
    expect(r2.recipients).toBe(0);
    expect(r2.sent).toBe(0);
    expect(messaging.sent).toHaveLength(1);
  });

  it("通知 OFF の人・アーカイブ済みには送らない", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const off = await setup(sheets, "RO1");
    expect((await call(off.app, "PATCH", `/api/projects/${off.pid}/me`, off.owner, { notify: false })).status).toBe(200);
    const arc = await setup(sheets, "RO2");
    expect((await call(arc.app, "POST", `/api/projects/${arc.pid}/archive`, arc.owner)).status).toBe(200);
    const messaging = createFakeMessagingClient();

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r.recipients).toBe(0);
    expect(r.sent).toBe(0);
    expect(messaging.sent).toHaveLength(0);
    expect(await logCount("RO1")).toBe(0);
    expect(await logCount("RO2")).toBe(0);
  });

  it("自分の側で絞る", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RP1");
    const member = await invite(app, pid, owner, "RP2");
    expect((await call(app, "PATCH", `/api/projects/${pid}/me`, owner, { party: "A社" })).status).toBe(200);
    expect((await call(app, "PATCH", `/api/projects/${pid}/me`, member, { party: "自社" })).status).toBe(200);
    const messaging = createFakeMessagingClient();

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r).toMatchObject({ recipients: 2, sent: 2, items: 3 });
    expect(messaging.sent.map((s) => s.to)).toEqual(["RP1", "RP2"]);
    const [p1, p2] = messaging.sent.map((s) => s.text);
    expect(p1).toContain("明日の件");
    expect(p1).toContain("3 日前の件");
    expect(p1).not.toContain("今日の件");
    expect(p2).toContain("今日の件");
    expect(p2).not.toContain("明日の件");
    expect(await logCount("RP1")).toBe(2);
    expect(await logCount("RP2")).toBe(1);
  });

  it("友だちでない人は送らず、記録もしない（翌日の再実行で届く）", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    await setup(sheets, "RF1");
    const notFriend = createFakeMessagingClient({ friends: () => false });

    const r1 = await runNotifications(env, { sheets, messaging: notFriend, now });
    expect(r1).toMatchObject({ recipients: 1, sent: 0, items: 0 });
    expect(r1.skipped).toMatchObject({ notFriend: 1, quota: 0, error: 0 });
    expect(notFriend.sent).toHaveLength(0);
    expect(await logCount("RF1")).toBe(0);

    // 友だちになったあとの再実行では届く
    const friend = createFakeMessagingClient();
    const r2 = await runNotifications(env, { sheets, messaging: friend, now });
    expect(r2).toMatchObject({ recipients: 1, sent: 1, items: 3 });
    expect(friend.sent.map((s) => s.to)).toEqual(["RF1"]);
  });

  it("Cron のあと、友だちの人は line_friend = 1、友だちでない人は 0", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RY1");
    await invite(app, pid, owner, "RY2");
    const messaging = createFakeMessagingClient({ friends: (id) => id === "RY1" });

    await runNotifications(env, { sheets, messaging, now });

    const friendRow = await env.DB.prepare("SELECT line_friend FROM users WHERE line_user_id = ?")
      .bind("RY1")
      .first<{ line_friend: number | null }>();
    expect(friendRow?.line_friend).toBe(1);
    const notFriendRow = await env.DB.prepare("SELECT line_friend FROM users WHERE line_user_id = ?")
      .bind("RY2")
      .first<{ line_friend: number | null }>();
    expect(notFriendRow?.line_friend).toBe(0);
  });

  it("残り通数が足りなければ、足りる人数だけ送る", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RL1");
    await invite(app, pid, owner, "RL2");
    const messaging = createFakeMessagingClient({ limit: 10, used: 9 });

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r).toMatchObject({ recipients: 2, sent: 1, items: 3 });
    expect(r.skipped).toMatchObject({ notFriend: 0, quota: 1, error: 0 });
    expect(messaging.sent.map((s) => s.to)).toEqual(["RL1"]);
    expect(await logCount("RL2")).toBe(0);
  });

  it("友だちでない人は残り通数を使わない", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RM1");
    await invite(app, pid, owner, "RM2");
    const messaging = createFakeMessagingClient({ limit: 10, used: 9, friends: (id) => id !== "RM1" });

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r.skipped).toMatchObject({ notFriend: 1, quota: 0, error: 0 });
    expect(messaging.sent.map((s) => s.to)).toEqual(["RM2"]);
  });

  it("1 人の push が失敗しても他の人には送る", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RQ1");
    await invite(app, pid, owner, "RQ2");
    const messaging = createFakeMessagingClient({ failFor: (id) => id === "RQ1" });

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r).toMatchObject({ recipients: 2, sent: 1, items: 3 });
    expect(r.skipped).toMatchObject({ notFriend: 0, quota: 0, error: 1 });
    expect(messaging.sent.map((s) => s.to)).toEqual(["RQ2"]);
    expect(await logCount("RQ1")).toBe(0);
    expect(await logCount("RQ2")).toBe(3);
  });

  it("isFriend が例外を投げた人は error に数えて続ける", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RE1");
    await invite(app, pid, owner, "RE2");
    const base = createFakeMessagingClient();
    const messaging = {
      ...base,
      async isFriend(id: string) {
        if (id === "RE1") throw new Error("boom");
        return true;
      },
    };

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r.skipped).toMatchObject({ notFriend: 0, quota: 0, error: 1 });
    expect(base.sent.map((s) => s.to)).toEqual(["RE2"]);
    expect(await logCount("RE1")).toBe(0);
  });

  it("残り通数が取れなければ上限なしとして送る", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    await setup(sheets, "RG1");
    const base = createFakeMessagingClient();
    const messaging = {
      ...base,
      async getQuota(): Promise<{ limit: number | null; used: number }> {
        throw new Error("quota down");
      },
    };

    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r).toMatchObject({ recipients: 1, sent: 1, items: 3 });
    expect(base.sent.map((s) => s.to)).toEqual(["RG1"]);
  });

  it("シートが読めないプロジェクトは飛ばす", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const bad = await setup(sheets, "RS1");
    await invite(bad.app, bad.pid, bad.owner, "RS2");
    await env.DB.prepare("UPDATE projects SET spreadsheet_id = ? WHERE id = ?").bind("x-noaccess-RS1", bad.pid).run();
    await setup(sheets, "RS3");
    const messaging = createFakeMessagingClient();

    const expectedSheet = await unreadableTargets(store);
    expect(expectedSheet).toBeGreaterThanOrEqual(2);
    const r = await runNotifications(env, { sheets, messaging, now });
    expect(r).toEqual({ recipients: 1, sent: 1, items: 3, skipped: { notFriend: 0, quota: 0, error: 0, sheet: expectedSheet } });
    expect(messaging.sent.map((s) => s.to)).toEqual(["RS3"]);
  });

  it("Messaging API が未設定なら何もしない", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    await setup(sheets, "RZ1");
    expect(await runNotifications(env, { sheets, messaging: null, now })).toEqual(ZERO);
    expect(await logCount("RZ1")).toBe(0);
  });

  it("30 日より前の記録を消す", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { pid } = await setup(sheets, "RD1");
    const insert = env.DB.prepare(
      `INSERT INTO notification_log (line_user_id, project_id, task_key, kind, due, sent_at) VALUES ('RD1', ?, ?, 'due', ?, ?)`,
    );
    await insert.bind(pid, "old", "2026-08-10", "2026-08-10T09:00:00+09:00").run();
    await insert.bind(pid, "keep", "2026-08-20", "2026-08-20T09:00:00+09:00").run();

    // 知らせるものが無くても消す
    await runNotifications(env, { sheets, messaging: createFakeMessagingClient({ friends: () => false }), now });
    const { results } = await env.DB.prepare("SELECT task_key FROM notification_log WHERE line_user_id = 'RD1' ORDER BY task_key")
      .all<{ task_key: string }>();
    expect(results.map((r) => r.task_key)).toEqual(["keep"]);
  });

  it("同じ日の再実行で duplicate が返っても、送れたものとして数えて記録し直す", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    await setup(sheets, "RU1");
    const messaging = createFakeMessagingClient();

    const r1 = await runNotifications(env, { sheets, messaging, now });
    expect(r1).toMatchObject({ recipients: 1, sent: 1, items: 3 });
    await env.DB.prepare("DELETE FROM notification_log WHERE line_user_id = 'RU1'").run();

    const r2 = await runNotifications(env, { sheets, messaging, now });
    expect(r2).toMatchObject({ recipients: 1, sent: 1, items: 3 });
    expect(r2.skipped).toMatchObject({ notFriend: 0, quota: 0, error: 0 });
    // 偽物は同じ retry key を duplicate として返し、2 通目は積まない
    expect(messaging.sent).toHaveLength(1);
    expect(await logCount("RU1")).toBe(3);
  });

  it("記録の書き込みに失敗しても、次の人に送り、古い記録も消す", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    const { app, pid, owner } = await setup(sheets, "RW1");
    await invite(app, pid, owner, "RW2");
    await env.DB.prepare(
      `INSERT INTO notification_log (line_user_id, project_id, task_key, kind, due, sent_at)
       VALUES ('RW1', ?, 'old', 'due', '2026-08-01', '2026-08-01T09:00:00+09:00')`,
    )
      .bind(pid)
      .run();

    // notification_log への INSERT を含む batch を 1 回だけ失敗させる（最初の人 = RW1）
    const logStmts = new WeakSet<D1PreparedStatement>();
    let failed = false;
    const db = {
      prepare(query: string) {
        const stmt = env.DB.prepare(query);
        if (!query.includes("INTO notification_log")) return stmt;
        return {
          bind(...values: unknown[]) {
            const bound = stmt.bind(...values);
            logStmts.add(bound);
            return bound;
          },
        };
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (!failed && stmts.some((s) => logStmts.has(s))) {
          failed = true;
          throw new Error("D1 down");
        }
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;
    const messaging = createFakeMessagingClient();
    const warn = vi.spyOn(console, "warn");

    try {
      const r = await runNotifications({ ...env, DB: db }, { sheets, messaging, now });
      expect(failed).toBe(true);
      // 記録に失敗した RW1 の 3 件も、届いた分として数える
      expect(r).toMatchObject({ recipients: 2, sent: 2, items: 6 });
      expect(r.skipped).toMatchObject({ notFriend: 0, quota: 0, error: 0 });
      expect(messaging.sent.map((s) => s.to)).toEqual(["RW1", "RW2"]);
      expect(warn).toHaveBeenCalledWith("[notify] log write failed");
      expect(warn.mock.calls.flat().some((a) => JSON.stringify(a ?? "").includes("RW"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
    // RW1 の今回分は記録できず、古い行は prune で消えている。RW2 は記録されている
    expect(await logCount("RW1")).toBe(0);
    expect(await logCount("RW2")).toBe(3);
  });

  it("古い記録の削除に失敗しても、結果を返す", async () => {
    const store = memoryStore();
    const sheets = createFakeSheetsClient(store);
    await setup(sheets, "RX1");
    const extra = await unreadableTargets(store);

    // notification_log の DELETE だけ失敗させる
    let pruneCalled = false;
    const db = {
      prepare(query: string) {
        const stmt = env.DB.prepare(query);
        if (!query.startsWith("DELETE FROM notification_log")) return stmt;
        return {
          bind() {
            return {
              async run() {
                pruneCalled = true;
                throw new Error("D1 down");
              },
            };
          },
        };
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
    } as unknown as D1Database;
    const messaging = createFakeMessagingClient();
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");

    try {
      const r = await runNotifications({ ...env, DB: db }, { sheets, messaging, now });
      expect(pruneCalled).toBe(true);
      expect(r).toEqual({ recipients: 1, sent: 1, items: 3, skipped: { notFriend: 0, quota: 0, error: 0, sheet: extra } });
      expect(warn).toHaveBeenCalledWith("[notify] prune failed");
      expect(log).toHaveBeenCalledWith("[notify] done", r);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(await logCount("RX1")).toBe(3);
  });

  it("dev 用の起動口は localhost 以外では 404", async () => {
    const res = await createApp().request(
      "https://tasks.example/api/dev/notifications/run",
      { method: "POST" },
      { ...env, DEV_MOCKS: "1" },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "見つかりません" });
  });

  it("dev 用の起動口は DEV_MOCKS が無ければ localhost でも 404", async () => {
    // .dev.vars の DEV_MOCKS がテストの env にも入るので、明示的に外す
    const res = await createApp().request(
      "http://localhost:5173/api/dev/notifications/run",
      { method: "POST" },
      { ...env, DEV_MOCKS: "0" },
    );
    expect(res.status).toBe(404);
  });

  // 本物の createDeps を通るので、時計は実時間になる（prune も実時間の 30 日前で走る）。
  // 前のテストの記録を実時間で消してしまわないよう、このテストは最後に置いておく。
  it("dev 用の起動口は localhost かつ DEV_MOCKS=1 なら結果を返す", async () => {
    const res = await createApp().request(
      "http://localhost:5173/api/dev/notifications/run",
      { method: "POST" },
      { ...env, DEV_MOCKS: "1" },
    );
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["items", "recipients", "sent", "skipped"]);
  });
});
