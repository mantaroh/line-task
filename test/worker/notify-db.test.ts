import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  insertNotificationLog,
  keyOf,
  listLoggedKeys,
  listNotifyTargets,
  pruneNotificationLog,
} from "../../src/worker/db";
import type { NotificationKey } from "../../src/worker/notify/types";

const NOW = "2026-09-15T09:00:00+09:00";

async function insertUser(uid: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (line_user_id, display_name, picture_url, created_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)`,
  )
    .bind(uid, uid, NOW, NOW)
    .run();
}

async function insertProject(
  id: string,
  p: { name: string; parties: string[]; sheet: string | null; archived: boolean; by: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO projects (id, name, parties, spreadsheet_id, next_task_no, created_by, created_at, archived_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, p.name, JSON.stringify(p.parties), p.sheet, p.by, NOW, p.archived ? NOW : null)
    .run();
}

async function insertMember(pid: string, uid: string, notify: number | null, party: string | null): Promise<void> {
  if (notify === null) {
    // 既定値（notify = 1、party = NULL）で入ることも確かめる
    await env.DB.prepare(`INSERT INTO members (project_id, line_user_id, joined_at, joined_via) VALUES (?, ?, ?, 'create')`)
      .bind(pid, uid, NOW)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO members (project_id, line_user_id, joined_at, joined_via, notify, party) VALUES (?, ?, ?, 'create', ?, ?)`,
  )
    .bind(pid, uid, NOW, notify, party)
    .run();
}

describe("通知の D1", () => {
  it("listNotifyTargets は ON・未アーカイブ・シートあり だけ", async () => {
    await insertUser("ndb-u2");
    await insertUser("ndb-u1");
    await insertProject("ndb-pB", { name: "B", parties: ["A社", "自社"], sheet: "sheetB", archived: false, by: "ndb-u1" });
    await insertProject("ndb-pA", { name: "A", parties: ["社内", "外部"], sheet: "sheetA", archived: false, by: "ndb-u1" });
    await insertProject("ndb-pNoSheet", { name: "N", parties: ["x", "y"], sheet: null, archived: false, by: "ndb-u1" });
    await insertProject("ndb-pArc", { name: "R", parties: ["x", "y"], sheet: "sheetR", archived: true, by: "ndb-u1" });

    await insertMember("ndb-pB", "ndb-u1", 1, "A社");
    await insertMember("ndb-pA", "ndb-u1", null, null);
    await insertMember("ndb-pNoSheet", "ndb-u1", 1, null);
    await insertMember("ndb-pArc", "ndb-u1", 1, null);
    await insertMember("ndb-pA", "ndb-u2", 0, null);
    await insertMember("ndb-pB", "ndb-u2", 1, null);

    const all = await listNotifyTargets(env.DB);
    const mine = all.filter((t) => t.lineUserId.startsWith("ndb-"));
    expect(mine).toEqual([
      { lineUserId: "ndb-u1", projectId: "ndb-pA", projectName: "A", parties: ["社内", "外部"], spreadsheetId: "sheetA", party: null },
      { lineUserId: "ndb-u1", projectId: "ndb-pB", projectName: "B", parties: ["A社", "自社"], spreadsheetId: "sheetB", party: "A社" },
      { lineUserId: "ndb-u2", projectId: "ndb-pB", projectName: "B", parties: ["A社", "自社"], spreadsheetId: "sheetB", party: null },
    ]);
  });

  it("記録の書き込みは重複を無視し、due で絞って読める", async () => {
    await insertUser("U");
    await insertProject("p", { name: "P", parties: ["a", "b"], sheet: "s", archived: false, by: "U" });
    const k = { lineUserId: "U", projectId: "p", taskKey: "T-001", kind: "due" as const, due: "2026-09-15" };
    await insertNotificationLog(env.DB, [k, k], NOW);
    await insertNotificationLog(env.DB, [], NOW);
    expect([...(await listLoggedKeys(env.DB, "2026-09-12"))]).toEqual([keyOf(k)]);
    expect([...(await listLoggedKeys(env.DB, "2026-09-16"))]).toEqual([]);
    expect(keyOf(k)).toBe("U p T-001 due 2026-09-15");
  });

  it("50 件を超えても分けて書ける", async () => {
    await insertUser("ndb-many");
    await insertProject("ndb-pm", { name: "M", parties: ["a", "b"], sheet: "s", archived: false, by: "ndb-many" });
    const keys: NotificationKey[] = Array.from({ length: 123 }, (_, i) => ({
      lineUserId: "ndb-many",
      projectId: "ndb-pm",
      taskKey: `T-${i}`,
      kind: "before",
      due: "2030-01-02",
    }));
    await insertNotificationLog(env.DB, keys, NOW);
    const logged = await listLoggedKeys(env.DB, "2030-01-01");
    expect([...logged].filter((s) => s.startsWith("ndb-many ")).sort()).toEqual(keys.map(keyOf).sort());
  });

  it("古い記録を消す", async () => {
    await insertUser("ndb-old");
    await insertProject("ndb-po", { name: "O", parties: ["a", "b"], sheet: "s", archived: false, by: "ndb-old" });
    const base = { lineUserId: "ndb-old", projectId: "ndb-po", kind: "after3" as const, due: "2031-01-01" };
    await insertNotificationLog(env.DB, [{ ...base, taskKey: "old" }], "2026-08-01T09:00:00+09:00");
    await insertNotificationLog(env.DB, [{ ...base, taskKey: "edge" }], "2026-08-16T09:00:00+09:00");
    await insertNotificationLog(env.DB, [{ ...base, taskKey: "new" }], "2026-09-15T09:00:00+09:00");
    await pruneNotificationLog(env.DB, "2026-08-16T09:00:00+09:00");
    const left = [...(await listLoggedKeys(env.DB, "2031-01-01"))].filter((s) => s.startsWith("ndb-old ")).sort();
    expect(left).toEqual([keyOf({ ...base, taskKey: "edge" }), keyOf({ ...base, taskKey: "new" })].sort());
  });
});
