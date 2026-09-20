// D1 に対する共通のクエリ関数。

import type { ActivityItem, InviteSummary, Member, MemberSettings } from "../shared/types";
import { HttpError } from "./errors";
import type { NotificationKey, NotifyTarget } from "./notify/types";

export type ProjectRow = {
  id: string;
  name: string;
  parties: string[];
  spreadsheet_id: string | null;
  next_task_no: number;
  created_by: string;
  created_at: string;
  archived_at: string | null;
};

type ProjectRawRow = Omit<ProjectRow, "parties"> & { parties: string };

function fromRawProject(row: ProjectRawRow): ProjectRow {
  return { ...row, parties: JSON.parse(row.parties) as string[] };
}

export async function upsertUser(
  db: D1Database,
  u: { lineUserId: string; displayName: string; pictureUrl: string | null },
  now: string,
): Promise<{ isNew: boolean }> {
  const existing = await db.prepare("SELECT 1 FROM users WHERE line_user_id = ?").bind(u.lineUserId).first();
  const isNew = existing === null;
  await db
    .prepare(
      `INSERT INTO users (line_user_id, display_name, picture_url, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         picture_url = excluded.picture_url,
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(u.lineUserId, u.displayName, u.pictureUrl, now, now)
    .run();
  return { isNew };
}

export async function getProjectForMember(db: D1Database, pid: string, uid: string): Promise<ProjectRow | null> {
  const row = await db
    .prepare(
      `SELECT p.* FROM projects p JOIN members m ON m.project_id = p.id
       WHERE p.id = ? AND m.line_user_id = ?`,
    )
    .bind(pid, uid)
    .first<ProjectRawRow>();
  return row ? fromRawProject(row) : null;
}

export async function listProjectsForUser(db: D1Database, uid: string): Promise<ProjectRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM projects p JOIN members m ON m.project_id = p.id
       WHERE m.line_user_id = ? ORDER BY p.created_at DESC, p.rowid DESC`,
    )
    .bind(uid)
    .all<ProjectRawRow>();
  return results.map(fromRawProject);
}

export async function countActiveCreatedBy(db: D1Database, uid: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM projects WHERE created_by = ? AND archived_at IS NULL`)
    .bind(uid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createProject(
  db: D1Database,
  p: { id: string; name: string; parties: string[]; createdBy: string },
  now: string,
): Promise<void> {
  const insertProject = db
    .prepare(
      `INSERT INTO projects (id, name, parties, spreadsheet_id, next_task_no, created_by, created_at, archived_at)
       VALUES (?, ?, ?, NULL, 1, ?, ?, NULL)`,
    )
    .bind(p.id, p.name, JSON.stringify(p.parties), p.createdBy, now);
  const insertMember = db
    .prepare(`INSERT INTO members (project_id, line_user_id, joined_at, joined_via) VALUES (?, ?, ?, 'create')`)
    .bind(p.id, p.createdBy, now);
  await db.batch([insertProject, insertMember]);
}

export async function updateProject(
  db: D1Database,
  pid: string,
  patch: { name?: string; parties?: string[] },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    values.push(patch.name);
  }
  if (patch.parties !== undefined) {
    sets.push("parties = ?");
    values.push(JSON.stringify(patch.parties));
  }
  if (sets.length === 0) return;
  values.push(pid);
  await db
    .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function getSheetBinding(db: D1Database, sid: string): Promise<{ project_id: string } | null> {
  const row = await db.prepare(`SELECT project_id FROM sheet_bindings WHERE spreadsheet_id = ?`).bind(sid).first<{ project_id: string }>();
  return row ?? null;
}

export async function bindSheet(db: D1Database, pid: string, sid: string, now: string): Promise<void> {
  const insertBindingStmt = db
    .prepare(
      `INSERT INTO sheet_bindings (spreadsheet_id, project_id, bound_at) VALUES (?, ?, ?)
       ON CONFLICT(spreadsheet_id) DO NOTHING`,
    )
    .bind(sid, pid, now);
  const updateProjectStmt = db
    .prepare(
      `UPDATE projects SET spreadsheet_id = ? WHERE id = ? AND EXISTS (
         SELECT 1 FROM sheet_bindings WHERE spreadsheet_id = ? AND project_id = ?
       )`,
    )
    .bind(sid, pid, sid, pid);
  await db.batch([insertBindingStmt, updateProjectStmt]);
  const binding = await getSheetBinding(db, sid);
  if (!binding || binding.project_id !== pid) {
    throw new HttpError(409, "sheet_in_use", "このシートは別のプロジェクトで使われています");
  }
}

export async function setArchived(db: D1Database, pid: string, archivedAt: string | null): Promise<void> {
  await db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).bind(archivedAt, pid).run();
}

export async function listMembers(db: D1Database, pid: string): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT m.line_user_id AS lineUserId, u.display_name AS displayName, u.picture_url AS pictureUrl,
              m.joined_at AS joinedAt, m.party AS party
       FROM members m JOIN users u ON u.line_user_id = m.line_user_id
       WHERE m.project_id = ? ORDER BY m.joined_at, m.rowid`,
    )
    .bind(pid)
    .all<Member>();
  return results;
}

export async function logActivity(
  db: D1Database,
  pid: string,
  actor: string,
  action: string,
  detail: unknown,
  now: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO activity (project_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)`)
    .bind(pid, actor, action, detail === undefined || detail === null ? null : JSON.stringify(detail), now)
    .run();
}

// minNo より小さい番号は返さない（シートにもともとある ID と重ならないように）。1 文で行うので同時に呼んでも重ならない
export async function nextTaskNo(db: D1Database, pid: string, minNo = 1): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE projects SET next_task_no = MAX(next_task_no, ?) + 1 WHERE id = ? RETURNING next_task_no - 1 AS n`,
    )
    .bind(minNo, pid)
    .first<{ n: number }>();
  if (row === null) throw new Error(`nextTaskNo: project not found: ${pid}`);
  return row.n;
}

export type InviteRow = {
  id: string;
  token_hash: string;
  project_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  use_count: number;
};

export async function createInvite(
  db: D1Database,
  i: { id: string; tokenHash: string; projectId: string; createdBy: string; expiresAt: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO invites (id, token_hash, project_id, created_by, created_at, expires_at, revoked_at, use_count)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
    )
    .bind(i.id, i.tokenHash, i.projectId, i.createdBy, now, i.expiresAt)
    .run();
}

type InviteSummaryRow = {
  id: string;
  createdAt: string;
  expiresAt: string;
  useCount: number;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
};

export async function listActiveInvites(db: D1Database, pid: string, now: string): Promise<InviteSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.created_at AS createdAt, i.expires_at AS expiresAt, i.use_count AS useCount,
              u.line_user_id AS lineUserId, u.display_name AS displayName, u.picture_url AS pictureUrl
       FROM invites i JOIN users u ON u.line_user_id = i.created_by
       WHERE i.project_id = ? AND i.revoked_at IS NULL AND i.expires_at > ?
       ORDER BY i.created_at DESC, i.rowid DESC`,
    )
    .bind(pid, now)
    .all<InviteSummaryRow>();
  return results.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    useCount: r.useCount,
    createdBy: { lineUserId: r.lineUserId, displayName: r.displayName, pictureUrl: r.pictureUrl },
  }));
}

export async function revokeInvite(db: D1Database, pid: string, inviteId: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE invites SET revoked_at = ? WHERE project_id = ? AND id = ? AND revoked_at IS NULL`)
    .bind(now, pid, inviteId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findInviteByHash(
  db: D1Database,
  hash: string,
): Promise<(InviteRow & { project_name: string; archived_at: string | null; created_by_name: string }) | null> {
  return db
    .prepare(
      `SELECT i.id, i.token_hash, i.project_id, i.created_by, i.created_at, i.expires_at, i.revoked_at, i.use_count,
              p.name AS project_name, p.archived_at, u.display_name AS created_by_name
       FROM invites i
       JOIN projects p ON p.id = i.project_id
       JOIN users u ON u.line_user_id = i.created_by
       WHERE i.token_hash = ?`,
    )
    .bind(hash)
    .first<InviteRow & { project_name: string; archived_at: string | null; created_by_name: string }>();
}

export async function addMember(db: D1Database, pid: string, uid: string, via: string, now: string): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO members (project_id, line_user_id, joined_at, joined_via) VALUES (?, ?, ?, ?)`)
    .bind(pid, uid, now, via)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function incrementInviteUse(db: D1Database, inviteId: string): Promise<void> {
  await db.prepare(`UPDATE invites SET use_count = use_count + 1 WHERE id = ?`).bind(inviteId).run();
}

// 人数の確認と削除を 1 文で行う。同時に抜けても 0 人にならない。
// false は「対象がいない」か「最後の 1 人」。呼び出し側で対象の有無を先に確かめる。
export async function removeMemberUnlessLast(db: D1Database, pid: string, uid: string): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM members WHERE project_id = ? AND line_user_id = ?
         AND (SELECT COUNT(*) FROM members WHERE project_id = ?) > 1`,
    )
    .bind(pid, uid, pid)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

type ActivityRow = {
  id: number;
  action: string;
  detail: string | null;
  at: string;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
};

export async function listActivity(
  db: D1Database,
  pid: string,
  opts: { before?: number; taskId?: string; limit: number },
): Promise<ActivityItem[]> {
  const conds = ["a.project_id = ?"];
  const binds: unknown[] = [pid];
  if (opts.before !== undefined) {
    conds.push("a.id < ?");
    binds.push(opts.before);
  }
  if (opts.taskId !== undefined) {
    conds.push(`json_extract(a.detail, '$.taskId') = ?`);
    binds.push(opts.taskId);
  }
  binds.push(opts.limit);
  const { results } = await db
    .prepare(
      `SELECT a.id, a.action, a.detail, a.at,
              u.line_user_id AS lineUserId, u.display_name AS displayName, u.picture_url AS pictureUrl
       FROM activity a JOIN users u ON u.line_user_id = a.actor
       WHERE ${conds.join(" AND ")}
       ORDER BY a.id DESC
       LIMIT ?`,
    )
    .bind(...binds)
    .all<ActivityRow>();
  return results.map((r) => ({
    id: r.id,
    action: r.action,
    detail: r.detail === null ? null : JSON.parse(r.detail),
    at: r.at,
    actor: { lineUserId: r.lineUserId, displayName: r.displayName, pictureUrl: r.pictureUrl },
  }));
}

export async function getMemberSettings(db: D1Database, pid: string, uid: string): Promise<MemberSettings | null> {
  const row = await db
    .prepare(`SELECT notify, party FROM members WHERE project_id = ? AND line_user_id = ?`)
    .bind(pid, uid)
    .first<{ notify: number; party: string | null }>();
  return row ? { notify: row.notify === 1, party: row.party } : null;
}

export async function updateMemberSettings(
  db: D1Database,
  pid: string,
  uid: string,
  patch: Partial<MemberSettings>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.notify !== undefined) {
    sets.push("notify = ?");
    values.push(patch.notify ? 1 : 0);
  }
  if (patch.party !== undefined) {
    sets.push("party = ?");
    values.push(patch.party);
  }
  if (sets.length === 0) return;
  values.push(pid, uid);
  await db
    .prepare(`UPDATE members SET ${sets.join(", ")} WHERE project_id = ? AND line_user_id = ?`)
    .bind(...values)
    .run();
}

type NotifyTargetRow = Omit<NotifyTarget, "parties"> & { parties: string };

// 通知が ON で、アーカイブしておらず、シートがつながっているメンバーの一覧。
export async function listNotifyTargets(db: D1Database): Promise<NotifyTarget[]> {
  const { results } = await db
    .prepare(
      `SELECT m.line_user_id AS lineUserId, p.id AS projectId, p.name AS projectName, p.parties,
              p.spreadsheet_id AS spreadsheetId, m.party
       FROM members m JOIN projects p ON p.id = m.project_id
       WHERE m.notify = 1 AND p.archived_at IS NULL AND p.spreadsheet_id IS NOT NULL
       ORDER BY m.line_user_id, p.id`,
    )
    .all<NotifyTargetRow>();
  return results.map((r) => ({ ...r, parties: JSON.parse(r.parties) as string[] }));
}

export function keyOf(k: NotificationKey): string {
  return `${k.lineUserId} ${k.projectId} ${k.taskKey} ${k.kind} ${k.due}`;
}

export async function listLoggedKeys(db: D1Database, minDue: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT line_user_id AS lineUserId, project_id AS projectId, task_key AS taskKey, kind, due
       FROM notification_log WHERE due >= ?`,
    )
    .bind(minDue)
    .all<NotificationKey>();
  return new Set(results.map(keyOf));
}

// D1 は 1 文にバインドできる値が 100 個まで。1 行 6 個なので 16 行ずつに分ける。
const LOG_CHUNK = 16;

// 1 文の INSERT OR IGNORE で書く。多いときは分けて batch にする。
export async function insertNotificationLog(db: D1Database, keys: NotificationKey[], now: string): Promise<void> {
  if (keys.length === 0) return;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += LOG_CHUNK) {
    const chunk = keys.slice(i, i + LOG_CHUNK);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunk.flatMap((k) => [k.lineUserId, k.projectId, k.taskKey, k.kind, k.due, now]);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO notification_log (line_user_id, project_id, task_key, kind, due, sent_at)
           VALUES ${placeholders}`,
        )
        .bind(...values),
    );
  }
  await db.batch(stmts);
}

export async function pruneNotificationLog(db: D1Database, beforeIso: string): Promise<void> {
  await db.prepare(`DELETE FROM notification_log WHERE sent_at < ?`).bind(beforeIso).run();
}
