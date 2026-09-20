// 画面ごとのアクセスの記録と、LINE の友だち状態の保存。

import type { UsageView } from "../../shared/types";

export async function recordAccess(
  db: D1Database,
  a: { lineUserId: string; projectId: string | null; view: UsageView },
  now: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO access_log (at, line_user_id, project_id, view) VALUES (?, ?, ?, ?)`)
    .bind(now, a.lineUserId, a.projectId, a.view)
    .run();
}

export async function pruneAccessLog(db: D1Database, beforeIso: string): Promise<void> {
  await db.prepare(`DELETE FROM access_log WHERE at < ?`).bind(beforeIso).run();
}

export async function setLineFriend(db: D1Database, lineUserId: string, friend: boolean, now: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET line_friend = ?, line_friend_checked_at = ? WHERE line_user_id = ?`)
    .bind(friend ? 1 : 0, now, lineUserId)
    .run();
}
