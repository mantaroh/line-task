// タスクの動画・音声の保存先。中身は R2（画像と同じバケット）、情報は D1 の task_media に置く。
import type { MediaCounts, MediaKind, TaskMedia } from "../../shared/types";
import { signExpiry, signMediaPath, type MediaSize } from "./sign";

export type MediaRow = {
  id: string;
  project_id: string;
  task_id: string;
  kind: MediaKind;
  content_type: string;
  size: number;
  duration_ms: number | null;
  has_thumb: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
};

export function mediaKey(pid: string, id: string, size: MediaSize): string {
  return `projects/${pid}/media/${id}${size === "thumb" ? ".thumb.jpg" : ""}`;
}

export async function countActiveMedia(db: D1Database, pid: string, taskId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM task_media WHERE project_id = ? AND task_id = ? AND deleted_at IS NULL`)
    .bind(pid, taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertMedia(
  db: D1Database,
  m: { id: string; projectId: string; taskId: string; kind: MediaKind; contentType: string; size: number; durationMs: number | null; createdBy: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_media (id, project_id, task_id, kind, content_type, size, duration_ms, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(m.id, m.projectId, m.taskId, m.kind, m.contentType, m.size, m.durationMs, m.createdBy, now)
    .run();
}

type ListRow = MediaRow & { displayName: string; pictureUrl: string | null };

export async function listMedia(
  db: D1Database,
  pid: string,
  taskId: string,
  sign: { secret: string; now: Date },
): Promise<TaskMedia[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.display_name AS displayName, u.picture_url AS pictureUrl
       FROM task_media m JOIN users u ON u.line_user_id = m.created_by
       WHERE m.project_id = ? AND m.task_id = ? AND m.deleted_at IS NULL
       ORDER BY m.created_at, m.rowid`,
    )
    .bind(pid, taskId)
    .all<ListRow>();
  const exp = signExpiry(sign.now);
  return Promise.all(
    results.map(async (r) => ({
      id: r.id,
      taskId: r.task_id,
      kind: r.kind,
      contentType: r.content_type,
      size: r.size,
      durationMs: r.duration_ms,
      url: await signMediaPath(sign.secret, { pid, id: r.id, size: "full", exp }),
      thumbUrl: r.has_thumb ? await signMediaPath(sign.secret, { pid, id: r.id, size: "thumb", exp }) : null,
      createdBy: { lineUserId: r.created_by, displayName: r.displayName, pictureUrl: r.pictureUrl ?? null },
      createdAt: r.created_at,
    })),
  );
}

export async function getActiveMedia(db: D1Database, pid: string, id: string): Promise<MediaRow | null> {
  return db
    .prepare(`SELECT * FROM task_media WHERE id = ? AND project_id = ? AND deleted_at IS NULL`)
    .bind(id, pid)
    .first<MediaRow>();
}

export async function markThumb(db: D1Database, row: MediaRow): Promise<void> {
  await db.prepare(`UPDATE task_media SET has_thumb = 1 WHERE id = ? AND project_id = ?`).bind(row.id, row.project_id).run();
}

export async function deleteMedia(env: { DB: D1Database; IMAGES: R2Bucket }, row: MediaRow, now: string): Promise<void> {
  await env.IMAGES.delete([mediaKey(row.project_id, row.id, "full"), mediaKey(row.project_id, row.id, "thumb")]);
  await env.DB.prepare(`UPDATE task_media SET deleted_at = ? WHERE id = ? AND project_id = ?`)
    .bind(now, row.id, row.project_id)
    .run();
}

export async function countMediaByTask(db: D1Database, pid: string): Promise<MediaCounts> {
  const { results } = await db
    .prepare(
      `SELECT task_id AS taskId, kind, COUNT(*) AS n FROM task_media
       WHERE project_id = ? AND deleted_at IS NULL GROUP BY task_id, kind`,
    )
    .bind(pid)
    .all<{ taskId: string; kind: MediaKind; n: number }>();
  const counts: MediaCounts = {};
  for (const r of results) {
    const c = (counts[r.taskId] ??= { video: 0, audio: 0 });
    c[r.kind] = r.n;
  }
  return counts;
}
